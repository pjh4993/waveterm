// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Providers that are embedded in the AI panel via an Electron <webview> (an isolated
// browser surface, not an iframe, so it is not blocked by X-Frame-Options/CSP).
export type AIWebProvider = {
    key: string;
    label: string;
    icon: string; // FontAwesome class (e.g. "fa-sparkles")
    url: string;
    partition: string; // persistent partition keeps the login session across restarts
    appUrl?: string; // optional desktop deep-link
};

export const AIWebProviders: Record<string, AIWebProvider> = {
    claude: {
        key: "claude",
        label: "Claude",
        icon: "fa-sparkles",
        url: "https://claude.ai/",
        partition: "persist:aiweb-claude",
        appUrl: "claude://",
    },
    codex: {
        key: "codex",
        label: "ChatGPT Codex",
        icon: "fa-code",
        url: "https://chatgpt.com/codex",
        partition: "persist:aiweb-codex",
    },
    gemini: {
        key: "gemini",
        label: "Gemini",
        icon: "fa-gem",
        url: "https://gemini.google.com/app",
        partition: "persist:aiweb-gemini",
    },
};

export type AIPanelProviderOption = {
    key: string;
    label: string;
    icon: string;
};

export const AIPanelProviderOptions: AIPanelProviderOption[] = [
    { key: "wave", label: "Wave AI", icon: "fa-sparkles" },
    ...Object.values(AIWebProviders).map((p) => ({ key: p.key, label: p.label, icon: p.icon })),
];
