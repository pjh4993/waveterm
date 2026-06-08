// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTranscript(t *testing.T, lines []string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("writing transcript: %v", err)
	}
	return path
}

func TestTitleFromTranscript_PrefersLatestAiTitle(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"last-prompt","lastPrompt":"hi"}`,
		`{"type":"user","message":{"content":"hi"}}`,
		`{"type":"ai-title","aiTitle":"Understand the repo"}`,
		`{"type":"last-prompt","lastPrompt":"now do something else"}`,
		`{"type":"ai-title","aiTitle":"Review GitHub Actions CI failure"}`,
	})
	got := titleFromTranscript(path)
	if got != "Review GitHub Actions CI failure" {
		t.Fatalf("expected latest aiTitle, got %q", got)
	}
}

func TestTitleFromTranscript_FallsBackToLatestPrompt(t *testing.T) {
	path := writeTranscript(t, []string{
		`{"type":"last-prompt","lastPrompt":"hi"}`,
		`{"type":"last-prompt","lastPrompt":"explain what this repo does"}`,
	})
	got := titleFromTranscript(path)
	if got != "explain what this repo does" {
		t.Fatalf("expected latest prompt, got %q", got)
	}
}

func TestTitleFromTranscript_SkipsBlankAndMalformed(t *testing.T) {
	path := writeTranscript(t, []string{
		`not json`,
		`{"type":"ai-title","aiTitle":"Real Title"}`,
		`{"type":"ai-title","aiTitle":"   "}`,
		``,
	})
	got := titleFromTranscript(path)
	if got != "Real Title" {
		t.Fatalf("expected blank/malformed records skipped, got %q", got)
	}
}

func TestTitleFromTranscript_MissingFile(t *testing.T) {
	if got := titleFromTranscript("/no/such/transcript.jsonl"); got != "" {
		t.Fatalf("expected empty string for missing file, got %q", got)
	}
}

func TestTruncateClaudeTitle(t *testing.T) {
	long := strings.Repeat("a", ClaudeTitleMaxLen+10)
	if got := truncateClaudeTitle(long); len([]rune(got)) != ClaudeTitleMaxLen {
		t.Fatalf("expected truncation to %d runes, got %d", ClaudeTitleMaxLen, len([]rune(got)))
	}
	if got := truncateClaudeTitle("  first line\nsecond line  "); got != "first line" {
		t.Fatalf("expected first trimmed line, got %q", got)
	}
	if got := truncateClaudeTitle("   "); got != "" {
		t.Fatalf("expected empty for whitespace, got %q", got)
	}
}

func TestAddAndRemoveClaudeHook(t *testing.T) {
	hooks := map[string]any{
		"SessionStart": []any{
			map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "existing.py"}}},
		},
	}
	spec := claudeHookSpec{event: "SessionStart", command: "wsh claude title", matcher: "*"}

	if !addClaudeHook(hooks, spec) {
		t.Fatal("expected add to report a change")
	}
	if addClaudeHook(hooks, spec) {
		t.Fatal("expected second add to be a no-op (idempotent)")
	}
	groups := hooks["SessionStart"].([]any)
	if len(groups) != 2 {
		t.Fatalf("expected existing hook preserved + ours appended, got %d groups", len(groups))
	}

	if !removeClaudeHook(hooks, spec) {
		t.Fatal("expected remove to report a change")
	}
	groups = hooks["SessionStart"].([]any)
	if len(groups) != 1 {
		t.Fatalf("expected only the existing hook to remain, got %d groups", len(groups))
	}
	if removeClaudeHook(hooks, spec) {
		t.Fatal("expected second remove to be a no-op")
	}
}
