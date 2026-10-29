// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getConnStatusAtom } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { memo, useEffect, useMemo } from "react";
import { AIProviderDropdown } from "./aiproviderdropdown";
import { ClaudeHostState, ClaudeSessionRef, ClaudeSessionsModel } from "./claudesessions-model";

const AutoRefreshMs = 30000;

function formatRelativeTime(ts: number): string {
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return new Date(ts).toLocaleDateString();
}

function shortenPath(path: string, homeDir: string): string {
    if (!path) return "";
    if (homeDir && path.startsWith(homeDir)) {
        return "~" + path.slice(homeDir.length);
    }
    return path;
}

function sessionMatches(session: ClaudeSessionInfo, filter: string): boolean {
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return [session.title, session.lastprompt, session.cwd, session.sessionid].some((field) =>
        field?.toLowerCase().includes(needle)
    );
}

const IconButton = ({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) => {
    return (
        <button
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            className="text-gray-400 hover:text-white cursor-pointer transition-colors p-1 rounded"
            title={title}
        >
            <i className={cn("fa", icon)}></i>
        </button>
    );
};

const SessionRow = memo(({ sessionRef, homeDir }: { sessionRef: ClaudeSessionRef; homeDir: string }) => {
    const model = ClaudeSessionsModel.getInstance();
    const [pendingConfirm, setPendingConfirm] = useAtom(model.pendingConfirmAtom);
    const { conn, session } = sessionRef;
    const confirmKey = `${conn}:${session.sessionid}`;
    const isOpenHere = model.findOpenBlock(session.sessionid) != null;
    const possiblyLive = model.isPossiblyLiveUnknown(sessionRef);
    const isInteractive = session.runkind == "interactive";
    const label = session.title || session.lastprompt || "(untitled)";

    const handleClick = () => {
        if (model.needsConfirm(sessionRef)) {
            setPendingConfirm(confirmKey);
            return;
        }
        fireAndForget(() => model.openSession(sessionRef));
    };

    return (
        <div className="pl-6 pr-2">
            <div
                onClick={handleClick}
                className="py-1 px-2 rounded hover:bg-zinc-700/60 cursor-pointer transition-colors min-w-0"
                title={`${session.sessionid}\n${session.cwd ?? ""}`}
            >
                <div className="flex items-center gap-1.5 min-w-0">
                    {isOpenHere && (
                        <span className="text-[10px] px-1 rounded bg-green-700/40 text-green-300 flex-shrink-0">
                            open
                        </span>
                    )}
                    {!isOpenHere && session.runkind == "background" && (
                        <span
                            className="text-[10px] px-1 rounded bg-accent/30 text-accent flex-shrink-0"
                            title={`background session ${session.agentid} (${session.runstate || "running"}), click to attach`}
                        >
                            bg
                        </span>
                    )}
                    {!isOpenHere && isInteractive && (
                        <span
                            className="text-[10px] px-1 rounded bg-orange-700/40 text-orange-300 flex-shrink-0"
                            title={`running in another terminal (${session.runstate || "running"})`}
                        >
                            running
                        </span>
                    )}
                    {!isOpenHere && possiblyLive && (
                        <span className="text-[10px] px-1 rounded bg-yellow-700/40 text-yellow-300 flex-shrink-0">
                            active
                        </span>
                    )}
                    <span className="text-sm text-zinc-200 truncate">{label}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-zinc-500 min-w-0">
                    <span className="truncate">{shortenPath(session.cwd, homeDir)}</span>
                    <span className="ml-auto flex-shrink-0">{formatRelativeTime(session.modts)}</span>
                </div>
            </div>
            {pendingConfirm == confirmKey && (
                <div className="mx-2 mb-1 p-2 rounded bg-zinc-800 border border-yellow-700/60 text-xs text-zinc-300">
                    <div className="mb-1.5">
                        {isInteractive
                            ? "This session is running in another terminal and cannot be attached. Opening it here starts a fork with a new session id; the original keeps running."
                            : `Updated ${formatRelativeTime(session.modts)}. It may still be running elsewhere, and resuming it here would fork the conversation.`}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => fireAndForget(() => model.openSession(sessionRef))}
                            className="px-2 py-0.5 bg-accent/80 text-primary rounded hover:bg-accent transition-colors cursor-pointer"
                        >
                            {isInteractive ? "Open fork" : "Resume anyway"}
                        </button>
                        <button
                            onClick={() => setPendingConfirm(null)}
                            className="px-2 py-0.5 rounded hover:bg-zinc-700 transition-colors cursor-pointer"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
});

SessionRow.displayName = "SessionRow";

const ProfileSection = memo(
    ({ conn, profile, homeDir }: { conn: string; profile: ClaudeProfileSessions; homeDir: string }) => {
        const model = ClaudeSessionsModel.getInstance();
        const filter = useAtomValue(model.filterAtom);
        const collapsed = useAtomValue(model.collapsedAtom);
        const collapseKey = `${conn}|${profile.configdir}`;
        const isCollapsed = collapsed[collapseKey] ?? false;
        const sessions = profile.sessions.filter((s) => sessionMatches(s, filter));

        return (
            <div>
                <div
                    onClick={() => model.toggleCollapsed(collapseKey)}
                    className="group flex items-center gap-1.5 pl-4 pr-1 py-0.5 cursor-pointer hover:bg-zinc-800/60"
                    title={profile.configdir}
                >
                    <i
                        className={cn(
                            "fa text-[9px] text-zinc-500 w-3",
                            isCollapsed ? "fa-chevron-right" : "fa-chevron-down"
                        )}
                    ></i>
                    <i className="fa fa-user text-[11px] text-zinc-400"></i>
                    <span className="text-xs font-semibold text-zinc-300">{profile.profile}</span>
                    <span className="text-[11px] text-zinc-500">{sessions.length}</span>
                    <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                        <IconButton
                            icon="fa-plus"
                            title={`New Claude session (${profile.profile})`}
                            onClick={() => fireAndForget(() => model.newSession(conn, profile))}
                        />
                    </div>
                </div>
                {!isCollapsed && profile.agentserror && (
                    <div className="pl-10 pr-2 text-[11px] text-zinc-600 break-words">{profile.agentserror}</div>
                )}
                {!isCollapsed &&
                    sessions.map((session) => (
                        <SessionRow key={session.sessionid} sessionRef={{ conn, profile, session }} homeDir={homeDir} />
                    ))}
            </div>
        );
    }
);

ProfileSection.displayName = "ProfileSection";

const HostStatusLine = ({ conn, hostState }: { conn: string; hostState: ClaudeHostState }) => {
    const model = ClaudeSessionsModel.getInstance();
    const status = hostState?.status ?? "idle";
    if (status == "disconnected") {
        return (
            <button
                onClick={() => fireAndForget(() => model.connectHost(conn))}
                className="ml-6 my-1 px-2 py-0.5 text-xs rounded bg-zinc-700/60 hover:bg-zinc-700 text-zinc-300 cursor-pointer transition-colors"
            >
                Connect to list sessions
            </button>
        );
    }
    if (status == "nowsh") {
        return (
            <div className="ml-6 my-1 text-xs text-zinc-500">
                wsh is disabled for this connection, so sessions cannot be read.
                {hostState.error && <div className="text-zinc-600">{hostState.error}</div>}
            </div>
        );
    }
    if (status == "oldwsh") {
        return (
            <div className="ml-6 my-1 text-xs text-zinc-400">
                <div className="mb-1">The wsh on this host does not support session listing.</div>
                <button
                    onClick={() => fireAndForget(() => model.reinstallWsh(conn))}
                    className="px-2 py-0.5 rounded bg-zinc-700/60 hover:bg-zinc-700 text-zinc-300 cursor-pointer transition-colors"
                    title="Installs this app's wsh on the host and reconnects. Non-durable terminals on this host will restart."
                >
                    Update wsh and reconnect
                </button>
            </div>
        );
    }
    if (status == "error") {
        return <div className="ml-6 my-1 text-xs text-red-400 break-words">{hostState.error}</div>;
    }
    if (status == "ok" && (hostState.data?.profiles ?? []).length == 0) {
        return <div className="ml-6 my-1 text-xs text-zinc-500">No Claude Code profiles found.</div>;
    }
    return null;
};

const HostSection = memo(({ conn }: { conn: string }) => {
    const model = ClaudeSessionsModel.getInstance();
    const hosts = useAtomValue(model.hostsAtom);
    const collapsed = useAtomValue(model.collapsedAtom);
    const connStatusAtom = useMemo(() => getConnStatusAtom(conn), [conn]);
    const connStatus = useAtomValue(connStatusAtom);
    const hostState = hosts[conn];
    const isCollapsed = collapsed[conn] ?? false;
    const isLocal = conn == "local";
    const isConnected = isLocal || connStatus?.status == "connected";

    useEffect(() => {
        fireAndForget(() => model.refreshHost(conn));
    }, [conn, connStatus?.status, connStatus?.wshenabled]);

    const hostname = hostState?.data?.hostname;
    return (
        <div className="mb-1">
            <div
                onClick={() => model.toggleCollapsed(conn)}
                className="group flex items-center gap-1.5 pl-2 pr-1 py-1 cursor-pointer hover:bg-zinc-800/60"
            >
                <i
                    className={cn(
                        "fa text-[9px] text-zinc-500 w-3",
                        isCollapsed ? "fa-chevron-right" : "fa-chevron-down"
                    )}
                ></i>
                <i
                    className={cn(
                        "fa text-xs",
                        isLocal ? "fa-laptop" : "fa-server",
                        isConnected ? "text-green-400" : "text-zinc-600"
                    )}
                ></i>
                <span className={cn("text-sm font-semibold truncate", isConnected ? "text-white" : "text-zinc-500")}>
                    {isLocal ? "local" : conn}
                </span>
                {hostname && !isLocal && hostname != conn && (
                    <span className="text-[11px] text-zinc-600 truncate">{hostname}</span>
                )}
                {hostState?.status == "loading" && <i className="fa fa-spinner fa-spin text-[11px] text-zinc-500"></i>}
                <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton
                        icon="fa-rotate-right"
                        title="Refresh"
                        onClick={() => fireAndForget(() => model.refreshHost(conn))}
                    />
                </div>
            </div>
            {!isCollapsed && (
                <>
                    <HostStatusLine conn={conn} hostState={hostState} />
                    {hostState?.data?.profiles?.map((profile) => (
                        <ProfileSection
                            key={profile.configdir}
                            conn={conn}
                            profile={profile}
                            homeDir={hostState.data.homedir}
                        />
                    ))}
                </>
            )}
        </div>
    );
});

HostSection.displayName = "HostSection";

export const ClaudeSessionsPanel = memo(({ roundTopLeft }: { roundTopLeft: boolean }) => {
    const model = ClaudeSessionsModel.getInstance();
    const hostList = useAtomValue(model.hostListAtom);
    const [filter, setFilter] = useAtom(model.filterAtom);

    useEffect(() => {
        const interval = setInterval(() => fireAndForget(() => model.refreshAll()), AutoRefreshMs);
        return () => clearInterval(interval);
    }, []);

    return (
        <div
            data-aipanel="true"
            className="@container bg-zinc-900/70 flex flex-col relative mt-1 h-[calc(100%-4px)] border-2 border-transparent"
            style={{
                borderTopLeftRadius: roundTopLeft ? 10 : 0,
                borderTopRightRadius: 10,
                borderBottomRightRadius: 10,
                borderBottomLeftRadius: 10,
            }}
        >
            <div className="py-1 pl-2 pr-1 @xs:pl-3 border-b border-gray-600 flex items-center justify-between min-w-0">
                <AIProviderDropdown />
                <IconButton
                    icon="fa-rotate-right"
                    title="Refresh all"
                    onClick={() => fireAndForget(() => model.refreshAll())}
                />
            </div>
            <div className="px-2 py-1.5 border-b border-zinc-700">
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter sessions"
                    className="w-full bg-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 outline-none focus:ring-1 focus:ring-accent/60"
                />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
                {hostList.map((conn) => (
                    <HostSection key={conn} conn={conn} />
                ))}
            </div>
        </div>
    );
});

ClaudeSessionsPanel.displayName = "ClaudeSessionsPanel";
