// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const ClaudeTitlePrefix = "✨ "
const ClaudeTitleMaxLen = 60

var claudeCmd = &cobra.Command{
	Use:   "claude",
	Short: "Claude Code integration helpers",
}

var claudeTitleCmd = &cobra.Command{
	Use:   "title",
	Short: "set the block's panel title from a Claude Code hook payload",
	Long: `Set the current block's panel title (frame:text) from a Claude Code hook
payload read on stdin. Intended to be wired up as a Claude Code SessionStart /
UserPromptSubmit hook. The title is derived in this order:

  1. session_title from the payload (set via /resume or 'claude -n <name>')
  2. the most recent aiTitle in the session transcript (Claude's own summary)
  3. the most recent user prompt in the transcript
  4. the working-directory name

Use --clear (wired as a SessionEnd hook) to remove the title.`,
	Args:                  cobra.NoArgs,
	RunE:                  claudeTitleRun,
	PreRunE:               preRunSetupRpcClient,
	DisableFlagsInUseLine: true,
}

var claudeInstallHooksCmd = &cobra.Command{
	Use:                   "install-hooks",
	Short:                 "install (or remove) Wave's Claude Code title hooks",
	Long:                  `Idempotently merge Wave's Claude Code panel-title hooks into ~/.claude/settings.json. A timestamped backup is written before any change.`,
	Args:                  cobra.NoArgs,
	RunE:                  claudeInstallHooksRun,
	DisableFlagsInUseLine: true,
}

var (
	claudeTitleClear          bool
	claudeTitlePrefixFlag     string
	claudeInstallSettingsPath string
	claudeInstallDryRun       bool
	claudeInstallUninstall    bool
)

func init() {
	rootCmd.AddCommand(claudeCmd)
	claudeCmd.AddCommand(claudeTitleCmd)
	claudeCmd.AddCommand(claudeInstallHooksCmd)
	claudeTitleCmd.Flags().BoolVar(&claudeTitleClear, "clear", false, "clear the panel title (used by the SessionEnd hook)")
	claudeTitleCmd.Flags().StringVar(&claudeTitlePrefixFlag, "prefix", ClaudeTitlePrefix, "string prepended to the derived title")
	claudeInstallHooksCmd.Flags().StringVar(&claudeInstallSettingsPath, "settings", "", "path to Claude Code settings.json (default ~/.claude/settings.json)")
	claudeInstallHooksCmd.Flags().BoolVar(&claudeInstallDryRun, "dry-run", false, "print the resulting settings without writing")
	claudeInstallHooksCmd.Flags().BoolVar(&claudeInstallUninstall, "uninstall", false, "remove Wave's title hooks instead of adding them")
}

type claudeHookPayload struct {
	SessionTitle   string `json:"session_title"`
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
}

type claudeTranscriptLine struct {
	Type       string `json:"type"`
	AiTitle    string `json:"aiTitle"`
	LastPrompt string `json:"lastPrompt"`
}

func claudeTitleRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("claude:title", rtnErr == nil)
	}()

	oref, err := resolveBlockArg()
	if err != nil {
		return fmt.Errorf("resolving block: %w", err)
	}

	var meta map[string]any
	if claudeTitleClear {
		meta = map[string]any{"frame:text": nil}
	} else {
		title, err := deriveClaudeTitle()
		if err != nil {
			return err
		}
		if title == "" {
			return nil
		}
		meta = map[string]any{"frame:text": claudeTitlePrefixFlag + title}
	}

	err = wshclient.SetMetaCommand(RpcClient, wshrpc.CommandSetMetaData{
		ORef: *oref,
		Meta: meta,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("setting frame:text: %w", err)
	}
	return nil
}

func deriveClaudeTitle() (string, error) {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", fmt.Errorf("reading hook payload: %w", err)
	}
	var payload claudeHookPayload
	if len(strings.TrimSpace(string(data))) > 0 {
		// A malformed payload shouldn't abort the hook; fall through to the
		// remaining heuristics (which may still yield a cwd-based title).
		_ = json.Unmarshal(data, &payload)
	}

	if t := truncateClaudeTitle(payload.SessionTitle); t != "" {
		return t, nil
	}
	if payload.TranscriptPath != "" {
		if t := truncateClaudeTitle(titleFromTranscript(payload.TranscriptPath)); t != "" {
			return t, nil
		}
	}
	if payload.Cwd != "" {
		return filepath.Base(payload.Cwd), nil
	}
	return "", nil
}

// titleFromTranscript scans the JSONL transcript and returns the most recent
// aiTitle (Claude's own session summary), falling back to the most recent user
// prompt. aiTitle is generated only after the first exchange, so early in a
// session this returns the latest prompt instead.
func titleFromTranscript(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	var aiTitle, lastPrompt string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec claudeTranscriptLine
		if err := json.Unmarshal(line, &rec); err != nil {
			continue
		}
		switch rec.Type {
		case "ai-title":
			if strings.TrimSpace(rec.AiTitle) != "" {
				aiTitle = rec.AiTitle
			}
		case "last-prompt":
			if strings.TrimSpace(rec.LastPrompt) != "" {
				lastPrompt = rec.LastPrompt
			}
		}
	}
	if aiTitle != "" {
		return aiTitle
	}
	return lastPrompt
}

func truncateClaudeTitle(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		s = strings.TrimSpace(s[:idx])
	}
	r := []rune(s)
	if len(r) > ClaudeTitleMaxLen {
		r = r[:ClaudeTitleMaxLen]
	}
	return string(r)
}

type claudeHookSpec struct {
	event   string
	command string
	matcher string
}

// The hooks Wave manages. SessionStart/UserPromptSubmit set the title;
// SessionEnd clears it so the panel reverts to the automatic process title.
var claudeManagedHooks = []claudeHookSpec{
	{event: "SessionStart", command: "wsh claude title", matcher: "*"},
	{event: "UserPromptSubmit", command: "wsh claude title"},
	{event: "SessionEnd", command: "wsh claude title --clear", matcher: "*"},
}

func claudeSettingsPath() (string, error) {
	if claudeInstallSettingsPath != "" {
		return claudeInstallSettingsPath, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

func claudeInstallHooksRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("claude:install-hooks", rtnErr == nil)
	}()

	path, err := claudeSettingsPath()
	if err != nil {
		return err
	}

	settings, err := readClaudeSettings(path)
	if err != nil {
		return err
	}

	hooks := asStringMap(settings["hooks"])
	if hooks == nil {
		if settings["hooks"] != nil {
			return fmt.Errorf("%q: 'hooks' is not an object", path)
		}
		hooks = map[string]any{}
	}

	var changes []string
	for _, spec := range claudeManagedHooks {
		var changed bool
		if claudeInstallUninstall {
			changed = removeClaudeHook(hooks, spec)
			if changed {
				changes = append(changes, fmt.Sprintf("removed %s: %s", spec.event, spec.command))
			}
		} else {
			changed = addClaudeHook(hooks, spec)
			if changed {
				changes = append(changes, fmt.Sprintf("added %s: %s", spec.event, spec.command))
			}
		}
	}
	settings["hooks"] = hooks

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding settings: %w", err)
	}
	out = append(out, '\n')

	if len(changes) == 0 {
		if claudeInstallUninstall {
			WriteStdout("no Wave title hooks present in %s\n", path)
		} else {
			WriteStdout("Wave title hooks already installed in %s\n", path)
		}
		return nil
	}

	if claudeInstallDryRun {
		WriteStdout("(dry run) would update %s:\n", path)
		for _, c := range changes {
			WriteStdout("  - %s\n", c)
		}
		WriteStdout("\n%s", string(out))
		return nil
	}

	if err := writeClaudeSettings(path, out); err != nil {
		return err
	}
	WriteStdout("updated %s:\n", path)
	for _, c := range changes {
		WriteStdout("  - %s\n", c)
	}
	WriteStdout("Restart any running Claude Code sessions for the hooks to take effect.\n")
	return nil
}

func readClaudeSettings(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]any{}, nil
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if settings == nil {
		settings = map[string]any{}
	}
	return settings, nil
}

// writeClaudeSettings writes through any symlink (so a dotfiles-managed
// settings.json keeps its link) after writing a timestamped backup.
func writeClaudeSettings(path string, data []byte) error {
	target := path
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		target = resolved
	}
	if existing, err := os.ReadFile(target); err == nil {
		backup := fmt.Sprintf("%s.bak.%d", target, time.Now().Unix())
		if err := os.WriteFile(backup, existing, 0o600); err != nil {
			return fmt.Errorf("writing backup %s: %w", backup, err)
		}
		WriteStdout("backed up existing settings to %s\n", backup)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("creating settings directory: %w", err)
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		return fmt.Errorf("writing %s: %w", target, err)
	}
	return nil
}

func asStringMap(v any) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return m
}

func groupHasCommand(group any, command string) bool {
	gm := asStringMap(group)
	if gm == nil {
		return false
	}
	hookList, ok := gm["hooks"].([]any)
	if !ok {
		return false
	}
	for _, h := range hookList {
		hm := asStringMap(h)
		if hm == nil {
			continue
		}
		if cmd, _ := hm["command"].(string); cmd == command {
			return true
		}
	}
	return false
}

func addClaudeHook(hooks map[string]any, spec claudeHookSpec) bool {
	groups, _ := hooks[spec.event].([]any)
	for _, g := range groups {
		if groupHasCommand(g, spec.command) {
			return false
		}
	}
	group := map[string]any{
		"hooks": []any{
			map[string]any{"type": "command", "command": spec.command},
		},
	}
	if spec.matcher != "" {
		group["matcher"] = spec.matcher
	}
	hooks[spec.event] = append(groups, group)
	return true
}

// removeClaudeHook strips Wave's command from any group under the event,
// dropping groups that become empty. Returns true if anything was removed.
func removeClaudeHook(hooks map[string]any, spec claudeHookSpec) bool {
	groups, ok := hooks[spec.event].([]any)
	if !ok {
		return false
	}
	changed := false
	newGroups := make([]any, 0, len(groups))
	for _, g := range groups {
		gm := asStringMap(g)
		if gm == nil {
			newGroups = append(newGroups, g)
			continue
		}
		hookList, ok := gm["hooks"].([]any)
		if !ok {
			newGroups = append(newGroups, g)
			continue
		}
		newHooks := make([]any, 0, len(hookList))
		for _, h := range hookList {
			hm := asStringMap(h)
			if hm != nil {
				if cmd, _ := hm["command"].(string); cmd == spec.command {
					changed = true
					continue
				}
			}
			newHooks = append(newHooks, h)
		}
		if len(newHooks) == 0 {
			continue
		}
		gm["hooks"] = newHooks
		newGroups = append(newGroups, gm)
	}
	if len(newGroups) == 0 {
		delete(hooks, spec.event)
	} else {
		hooks[spec.event] = newGroups
	}
	return changed
}
