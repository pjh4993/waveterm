// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// A clean desktop Chrome user-agent. The default Electron webview UA contains
// "Electron"/the app name, which Google-based logins (Gemini, Google SSO) reject as
// an insecure browser; presenting a plain desktop Chrome UA avoids that.
export const USER_AGENT_DESKTOP =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// A single shared persistent partition for all providers, so one Google sign-in (used
// by Gemini and "Continue with Google" on the others) is reused everywhere instead of
// logging in per-provider. Cookies/storage are shared across the embedded providers.
export const AIWEB_SHARED_PARTITION = "persist:aiweb-shared";

// Providers that are embedded in the AI panel via an Electron <webview> (an isolated
// browser surface, not an iframe, so it is not blocked by X-Frame-Options/CSP).
export type AIWebProvider = {
    key: string;
    label: string;
    icon: string; // FontAwesome class (e.g. "fa-sparkles")
    url: string;
    partition: string; // persistent partition keeps the login session across restarts
    useragent?: string; // override the webview UA (defaults to USER_AGENT_DESKTOP)
    appUrl?: string; // optional desktop deep-link
};

export const AIWebProviders: Record<string, AIWebProvider> = {
    claude: {
        key: "claude",
        label: "Claude",
        icon: "fa-sparkles",
        url: "https://claude.ai/",
        partition: AIWEB_SHARED_PARTITION,
        appUrl: "claude://",
    },
    codex: {
        key: "codex",
        label: "ChatGPT Codex",
        icon: "fa-code",
        url: "https://chatgpt.com/codex",
        partition: AIWEB_SHARED_PARTITION,
    },
    gemini: {
        key: "gemini",
        label: "Gemini",
        icon: "fa-gem",
        url: "https://gemini.google.com/app",
        partition: AIWEB_SHARED_PARTITION,
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
