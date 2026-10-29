// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, createBlock, getConnStatusAtom, refocusNode } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isBlank, isLocalConnName, makeConnRoute } from "@/util/util";
import * as jotai from "jotai";

const LocalHostKey = "local";
const SessionsLimit = 30;
// must match ClaudeSessionsProtocolVersion in pkg/wshrpc/wshremote/claudesessions.go
const SessionsProtocolVersion = 2;
const FetchTimeoutMs = 20000;
const ConnectTimeoutMs = 60000;
// a transcript written this recently is probably still open in some other terminal
const RecentlyActiveMs = 2 * 60 * 1000;

export type ClaudeHostStatus = "idle" | "loading" | "ok" | "error" | "disconnected" | "nowsh" | "oldwsh";

export type ClaudeHostState = {
    conn: string;
    status: ClaudeHostStatus;
    error?: string;
    data?: ClaudeSessionsResponse;
};

export type ClaudeSessionRef = {
    conn: string;
    profile: ClaudeProfileSessions;
    session: ClaudeSessionInfo;
};

function shellQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function isUnknownCommandError(e: any): boolean {
    const msg = String(e?.message ?? e);
    return msg.includes("not found") && msg.includes("remoteclaudesessions");
}

export function isRecentlyActive(session: ClaudeSessionInfo): boolean {
    return Date.now() - session.modts < RecentlyActiveMs;
}

export class ClaudeSessionsModel {
    private static instance: ClaudeSessionsModel = null;

    hostsAtom = jotai.atom<Record<string, ClaudeHostState>>({}) as jotai.PrimitiveAtom<Record<string, ClaudeHostState>>;
    filterAtom = jotai.atom<string>("") as jotai.PrimitiveAtom<string>;
    collapsedAtom = jotai.atom<Record<string, boolean>>({}) as jotai.PrimitiveAtom<Record<string, boolean>>;
    pendingConfirmAtom = jotai.atom<string>(null) as jotai.PrimitiveAtom<string>;

    hostListAtom: jotai.Atom<string[]>;

    private constructor() {
        this.hostListAtom = jotai.atom((get) => {
            const fullConfig = get(atoms.fullConfigAtom);
            const connections = fullConfig?.connections ?? {};
            const remotes = Object.keys(connections)
                .filter((conn) => !isLocalConnName(conn) && !connections[conn]?.["display:hidden"])
                .sort((a, b) => (connections[a]?.["display:order"] ?? 0) - (connections[b]?.["display:order"] ?? 0));
            return [LocalHostKey, ...remotes];
        });
    }

    static getInstance(): ClaudeSessionsModel {
        if (!ClaudeSessionsModel.instance) {
            ClaudeSessionsModel.instance = new ClaudeSessionsModel();
        }
        return ClaudeSessionsModel.instance;
    }

    setHostState(conn: string, state: Partial<ClaudeHostState>) {
        const hosts = globalStore.get(this.hostsAtom);
        const prev = hosts[conn] ?? { conn, status: "idle" };
        globalStore.set(this.hostsAtom, { ...hosts, [conn]: { ...prev, ...state, conn } });
    }

    toggleCollapsed(key: string) {
        const collapsed = globalStore.get(this.collapsedAtom);
        globalStore.set(this.collapsedAtom, { ...collapsed, [key]: !collapsed[key] });
    }

    async refreshAll() {
        const hosts = globalStore.get(this.hostListAtom);
        await Promise.all(hosts.map((conn) => this.refreshHost(conn)));
    }

    async refreshHost(conn: string) {
        if (!isLocalConnName(conn)) {
            const connStatus = globalStore.get(getConnStatusAtom(conn));
            if (connStatus?.status != "connected") {
                this.setHostState(conn, { status: "disconnected", error: null });
                return;
            }
            if (!connStatus.wshenabled) {
                this.setHostState(conn, { status: "nowsh", error: connStatus.nowshreason || connStatus.wsherror });
                return;
            }
        }
        this.setHostState(conn, { status: "loading", error: null });
        try {
            const data = await RpcApi.RemoteClaudeSessionsCommand(
                TabRpcClient,
                { limit: SessionsLimit },
                { route: makeConnRoute(conn), timeout: FetchTimeoutMs }
            );
            if ((data?.version ?? 0) < SessionsProtocolVersion) {
                this.setHostState(conn, { status: "oldwsh", data, error: null });
                return;
            }
            this.setHostState(conn, { status: "ok", data, error: null });
        } catch (e) {
            if (isUnknownCommandError(e)) {
                this.setHostState(conn, { status: "oldwsh", error: null });
                return;
            }
            this.setHostState(conn, { status: "error", error: String(e?.message ?? e) });
        }
    }

    async connectHost(conn: string) {
        this.setHostState(conn, { status: "loading", error: null });
        try {
            await RpcApi.ConnEnsureCommand(TabRpcClient, { connname: conn }, { timeout: ConnectTimeoutMs });
        } catch (e) {
            this.setHostState(conn, { status: "error", error: String(e?.message ?? e) });
            return;
        }
        await this.refreshHost(conn);
    }

    async reinstallWsh(conn: string) {
        this.setHostState(conn, { status: "loading", error: null });
        try {
            await RpcApi.ConnReinstallWshCommand(TabRpcClient, { connname: conn }, { timeout: ConnectTimeoutMs });
            // the running connserver keeps the old binary until the connection is re-established
            await RpcApi.ConnDisconnectCommand(TabRpcClient, conn, { timeout: ConnectTimeoutMs });
            await RpcApi.ConnEnsureCommand(TabRpcClient, { connname: conn }, { timeout: ConnectTimeoutMs });
        } catch (e) {
            this.setHostState(conn, { status: "error", error: String(e?.message ?? e) });
            return;
        }
        await this.refreshHost(conn);
    }

    findOpenBlock(sessionId: string): string {
        const tabId = globalStore.get(atoms.staticTabId);
        const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        for (const blockId of tab?.blockids ?? []) {
            const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.["claude:sessionid"] == sessionId) {
                return blockId;
            }
        }
        return null;
    }

    // live state comes from `claude agents --json`; the mtime heuristic only applies when
    // that detection was unavailable on the host
    isPossiblyLiveUnknown(ref: ClaudeSessionRef): boolean {
        return !isBlank(ref.profile.agentserror) && !ref.session.runkind && isRecentlyActive(ref.session);
    }

    needsConfirm(ref: ClaudeSessionRef): boolean {
        if (this.findOpenBlock(ref.session.sessionid) != null) {
            return false;
        }
        if (ref.session.runkind == "background") {
            return false;
        }
        if (ref.session.runkind == "interactive") {
            return true;
        }
        return this.isPossiblyLiveUnknown(ref);
    }

    // A background session is attached. An interactive session is owned by another
    // terminal and cannot be attached, so it is opened as a fork with a new session id
    // rather than having two processes append to the same transcript.
    async openSession(ref: ClaudeSessionRef) {
        globalStore.set(this.pendingConfirmAtom, null);
        const { session } = ref;
        const existing = this.findOpenBlock(session.sessionid);
        if (existing != null) {
            refocusNode(existing);
            return;
        }
        if (session.runkind == "background") {
            const attachId = session.agentid || session.sessionid;
            await this.openClaudeBlock(
                ref.conn,
                ref.profile,
                session.cwd,
                `claude attach ${shellQuote(attachId)}`,
                session.sessionid
            );
            return;
        }
        if (session.runkind == "interactive") {
            const forkCmd = `claude --resume ${shellQuote(session.sessionid)} --fork-session`;
            await this.openClaudeBlock(ref.conn, ref.profile, session.cwd, forkCmd, null);
            return;
        }
        const resumeCmd = `claude --resume ${shellQuote(session.sessionid)}`;
        await this.openClaudeBlock(ref.conn, ref.profile, session.cwd, resumeCmd, session.sessionid);
    }

    async newSession(conn: string, profile: ClaudeProfileSessions) {
        await this.openClaudeBlock(conn, profile, null, "claude", null);
    }

    async openClaudeBlock(
        conn: string,
        profile: ClaudeProfileSessions,
        cwd: string,
        claudeCmd: string,
        sessionId: string
    ) {
        const envPrefix = profile.isdefault ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(profile.configdir)} `;
        const meta: MetaType = {
            view: "term",
            controller: "shell",
            "cmd:initscript": envPrefix + claudeCmd + "\n",
        };
        if (!isLocalConnName(conn)) {
            meta.connection = conn;
        }
        if (cwd) {
            meta["cmd:cwd"] = cwd;
        }
        if (sessionId) {
            meta["claude:sessionid"] = sessionId;
        }
        await createBlock({ meta });
    }
}
