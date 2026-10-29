// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshremote

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	// bump when the response shape or semantics change so the frontend can ask for a wsh update
	ClaudeSessionsProtocolVersion = 2
	ClaudeSessionsDefaultLimit    = 30
	ClaudeSessionsMaxLimit        = 200
	ClaudeTranscriptHeadBytes     = 64 * 1024
	ClaudeTranscriptTailBytes     = 256 * 1024
	ClaudeTitleMaxRunes           = 120
	ClaudeDefaultProfileDir       = ".claude"
	ClaudeDefaultProfileName      = "default"
	ClaudeAgentsTimeout           = 10 * time.Second
	ClaudeRunKindBackground       = "background"
	ClaudeRunKindInteractive      = "interactive"
)

type claudeAgentEntry struct {
	Id        string `json:"id"`
	Kind      string `json:"kind"`
	SessionId string `json:"sessionId"`
	State     string `json:"state"`
	Status    string `json:"status"`
	Cwd       string `json:"cwd"`
	Name      string `json:"name"`
	StartedAt int64  `json:"startedAt"`
}

type claudeTranscriptLine struct {
	Type        string `json:"type"`
	Cwd         string `json:"cwd"`
	AiTitle     string `json:"aiTitle"`
	CustomTitle string `json:"customTitle"`
	LastPrompt  string `json:"lastPrompt"`
}

type claudeTranscriptFile struct {
	path    string
	modTime time.Time
	size    int64
}

func (impl *ServerImpl) RemoteClaudeSessionsCommand(ctx context.Context, data wshrpc.CommandRemoteClaudeSessionsData) (*wshrpc.ClaudeSessionsResponse, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("cannot get home dir: %w", err)
	}
	limit := data.Limit
	if limit <= 0 {
		limit = ClaudeSessionsDefaultLimit
	}
	if limit > ClaudeSessionsMaxLimit {
		limit = ClaudeSessionsMaxLimit
	}
	hostname, _ := os.Hostname()
	rtn := &wshrpc.ClaudeSessionsResponse{
		Version:  ClaudeSessionsProtocolVersion,
		Hostname: hostname,
		HomeDir:  homeDir,
		Ts:       time.Now().UnixMilli(),
	}
	for _, configDir := range findClaudeConfigDirs(homeDir) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		rtn.Profiles = append(rtn.Profiles, readClaudeProfile(ctx, homeDir, configDir, limit))
	}
	return rtn, nil
}

// Profiles are discovered by convention: ~/.claude is the default profile and any
// ~/.claude-<name> directory with a projects/ subdir is a CLAUDE_CONFIG_DIR profile.
func findClaudeConfigDirs(homeDir string) []string {
	entries, err := os.ReadDir(homeDir)
	if err != nil {
		return nil
	}
	var rtn []string
	for _, entry := range entries {
		name := entry.Name()
		if name != ClaudeDefaultProfileDir && !strings.HasPrefix(name, ClaudeDefaultProfileDir+"-") {
			continue
		}
		dir := filepath.Join(homeDir, name)
		info, err := os.Stat(filepath.Join(dir, "projects"))
		if err != nil || !info.IsDir() {
			continue
		}
		rtn = append(rtn, dir)
	}
	sort.Slice(rtn, func(i, j int) bool {
		return filepath.Base(rtn[i]) == ClaudeDefaultProfileDir || (filepath.Base(rtn[j]) != ClaudeDefaultProfileDir && rtn[i] < rtn[j])
	})
	return rtn
}

func claudeProfileName(configDir string) string {
	base := filepath.Base(configDir)
	if base == ClaudeDefaultProfileDir {
		return ClaudeDefaultProfileName
	}
	return strings.TrimPrefix(base, ClaudeDefaultProfileDir+"-")
}

func readClaudeProfile(ctx context.Context, homeDir string, configDir string, limit int) wshrpc.ClaudeProfileSessions {
	profile := wshrpc.ClaudeProfileSessions{
		Profile:   claudeProfileName(configDir),
		ConfigDir: configDir,
		IsDefault: filepath.Base(configDir) == ClaudeDefaultProfileDir,
		Sessions:  []wshrpc.ClaudeSessionInfo{},
	}
	files := listClaudeTranscripts(filepath.Join(configDir, "projects"))
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.After(files[j].modTime)
	})
	agents, agentsErr := readClaudeAgents(ctx, homeDir, configDir, profile.IsDefault)
	if agentsErr != nil {
		profile.AgentsError = agentsErr.Error()
	}
	// running sessions are always listed, even when they fall outside the most-recent window
	var selected []claudeTranscriptFile
	for idx, file := range files {
		_, isRunning := agents[transcriptSessionId(file.path)]
		if idx < limit || isRunning {
			selected = append(selected, file)
		}
	}
	seen := make(map[string]bool)
	for _, file := range selected {
		session := readClaudeTranscriptInfo(file)
		seen[session.SessionId] = true
		if agent, ok := agents[session.SessionId]; ok {
			applyClaudeAgent(&session, agent)
		}
		profile.Sessions = append(profile.Sessions, session)
	}
	// long-lived background jobs can outlive their transcript file but are still attachable
	for sessionId, agent := range agents {
		if seen[sessionId] {
			continue
		}
		session := wshrpc.ClaudeSessionInfo{
			SessionId: sessionId,
			Cwd:       agent.Cwd,
			Title:     truncateRunes(agent.Name, ClaudeTitleMaxRunes),
			ModTs:     agent.StartedAt,
		}
		applyClaudeAgent(&session, agent)
		profile.Sessions = append(profile.Sessions, session)
	}
	sort.SliceStable(profile.Sessions, func(i, j int) bool {
		return profile.Sessions[i].ModTs > profile.Sessions[j].ModTs
	})
	return profile
}

func applyClaudeAgent(session *wshrpc.ClaudeSessionInfo, agent claudeAgentEntry) {
	session.RunKind = agent.Kind
	session.AgentId = agent.Id
	session.RunState = agent.State
	if session.RunState == "" {
		session.RunState = agent.Status
	}
	if session.Title == "" {
		session.Title = truncateRunes(agent.Name, ClaudeTitleMaxRunes)
	}
}

func transcriptSessionId(path string) string {
	return strings.TrimSuffix(filepath.Base(path), ".jsonl")
}

// Only top-level <project>/<sessionid>.jsonl files are sessions; nested dirs hold subagent transcripts.
func listClaudeTranscripts(projectsDir string) []claudeTranscriptFile {
	projects, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil
	}
	var rtn []claudeTranscriptFile
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		projectDir := filepath.Join(projectsDir, project.Name())
		entries, err := os.ReadDir(projectDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
				continue
			}
			info, err := entry.Info()
			if err != nil || info.Size() == 0 {
				continue
			}
			rtn = append(rtn, claudeTranscriptFile{
				path:    filepath.Join(projectDir, entry.Name()),
				modTime: info.ModTime(),
				size:    info.Size(),
			})
		}
	}
	return rtn
}

// Transcripts can be hundreds of MB (and often live on NFS homes), so only the head
// (for cwd) and the tail (for the latest title/prompt records, which are appended) are read.
func readClaudeTranscriptInfo(file claudeTranscriptFile) wshrpc.ClaudeSessionInfo {
	rtn := wshrpc.ClaudeSessionInfo{
		SessionId: transcriptSessionId(file.path),
		ModTs:     file.modTime.UnixMilli(),
		Size:      file.size,
	}
	fd, err := os.Open(file.path)
	if err != nil {
		return rtn
	}
	defer fd.Close()
	head := readFileChunk(fd, 0, ClaudeTranscriptHeadBytes)
	var customTitle, aiTitle string
	scanTranscriptChunk(head, false, func(line claudeTranscriptLine) {
		if rtn.Cwd == "" && line.Cwd != "" {
			rtn.Cwd = line.Cwd
		}
		applyTranscriptTitles(line, &customTitle, &aiTitle, &rtn.LastPrompt)
	})
	if file.size > ClaudeTranscriptHeadBytes {
		tailStart := file.size - ClaudeTranscriptTailBytes
		if tailStart < ClaudeTranscriptHeadBytes {
			tailStart = ClaudeTranscriptHeadBytes
		}
		tail := readFileChunk(fd, tailStart, file.size-tailStart)
		scanTranscriptChunk(tail, true, func(line claudeTranscriptLine) {
			if rtn.Cwd == "" && line.Cwd != "" {
				rtn.Cwd = line.Cwd
			}
			applyTranscriptTitles(line, &customTitle, &aiTitle, &rtn.LastPrompt)
		})
	}
	rtn.Title = customTitle
	if rtn.Title == "" {
		rtn.Title = aiTitle
	}
	rtn.Title = truncateRunes(rtn.Title, ClaudeTitleMaxRunes)
	rtn.LastPrompt = truncateRunes(strings.TrimSpace(rtn.LastPrompt), ClaudeTitleMaxRunes)
	return rtn
}

func applyTranscriptTitles(line claudeTranscriptLine, customTitle *string, aiTitle *string, lastPrompt *string) {
	switch line.Type {
	case "custom-title":
		if line.CustomTitle != "" {
			*customTitle = line.CustomTitle
		}
	case "ai-title":
		if line.AiTitle != "" {
			*aiTitle = line.AiTitle
		}
	case "last-prompt":
		if strings.TrimSpace(line.LastPrompt) != "" {
			*lastPrompt = line.LastPrompt
		}
	}
}

func readFileChunk(fd *os.File, offset int64, size int64) []byte {
	if size <= 0 {
		return nil
	}
	buf := make([]byte, size)
	n, _ := fd.ReadAt(buf, offset)
	return buf[:n]
}

func scanTranscriptChunk(chunk []byte, skipFirstPartial bool, fn func(claudeTranscriptLine)) {
	lines := bytes.Split(chunk, []byte("\n"))
	if skipFirstPartial && len(lines) > 0 {
		lines = lines[1:]
	}
	for _, rawLine := range lines {
		if len(rawLine) == 0 || rawLine[0] != '{' {
			continue
		}
		if !bytes.Contains(rawLine, []byte(`"cwd"`)) && !bytes.Contains(rawLine, []byte(`-title"`)) && !bytes.Contains(rawLine, []byte(`"last-prompt"`)) {
			continue
		}
		var line claudeTranscriptLine
		if err := json.Unmarshal(rawLine, &line); err != nil {
			continue
		}
		fn(line)
	}
}

func truncateRunes(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "…"
}

// connserver is not started from a login shell, so claude is often not on PATH (it
// usually lives in ~/.local/bin); fall back to the standard install locations.
func findClaudeBinary(homeDir string) string {
	if path, err := exec.LookPath("claude"); err == nil {
		return path
	}
	candidates := []string{
		filepath.Join(homeDir, ".local", "bin", "claude"),
		filepath.Join(homeDir, ".claude", "local", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

// `claude agents --json` is the supported way to see which sessions are live (both
// background and interactive), which decides between attach, resume and fork.
func readClaudeAgents(ctx context.Context, homeDir string, configDir string, isDefault bool) (map[string]claudeAgentEntry, error) {
	rtn := make(map[string]claudeAgentEntry)
	if !isDefault {
		// with CLAUDE_CONFIG_DIR set, the CLI creates an empty .claude.json when none exists,
		// so a profile that was never logged in is left untouched
		if _, err := os.Stat(filepath.Join(configDir, ".claude.json")); err != nil {
			return rtn, nil
		}
	}
	claudePath := findClaudeBinary(homeDir)
	if claudePath == "" {
		return rtn, fmt.Errorf("claude CLI not found, running sessions cannot be detected")
	}
	ctx, cancel := context.WithTimeout(ctx, ClaudeAgentsTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, claudePath, "agents", "--json")
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "CLAUDE_CONFIG_DIR=") {
			continue
		}
		env = append(env, kv)
	}
	if !isDefault {
		env = append(env, "CLAUDE_CONFIG_DIR="+configDir)
	}
	cmd.Env = env
	output, err := cmd.Output()
	if err != nil {
		return rtn, fmt.Errorf("claude agents --json failed: %w", err)
	}
	var entries []claudeAgentEntry
	if err := json.Unmarshal(bytes.TrimSpace(output), &entries); err != nil {
		return rtn, fmt.Errorf("cannot parse claude agents output: %w", err)
	}
	for _, entry := range entries {
		if entry.SessionId == "" {
			continue
		}
		rtn[entry.SessionId] = entry
	}
	return rtn, nil
}
