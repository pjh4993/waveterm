// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useRef, useState } from "react";
import { AIPanelProviderOptions } from "./aiwebproviders";

export const AIProviderDropdown = memo(() => {
    const provider = useAtomValue(getSettingsKeyAtom("aipanel:provider")) ?? "wave";
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const current = AIPanelProviderOptions.find((p) => p.key === provider) ?? AIPanelProviderOptions[0];

    const handleSelect = (key: string) => {
        setIsOpen(false);
        if (key === provider) return;
        fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { "aipanel:provider": key }));
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "group flex items-center gap-2 px-2 py-1 text-sm font-semibold text-white rounded transition-colors cursor-pointer",
                    isOpen ? "bg-zinc-700" : "hover:bg-zinc-700/60"
                )}
                title="Select AI provider"
            >
                <i className={cn("fa", current.icon, "text-accent")}></i>
                <span className="whitespace-nowrap">{current.label}</span>
                <i className="fa fa-chevron-down text-[8px] text-gray-400"></i>
            </button>

            {isOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
                    <div className="absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-600 rounded shadow-lg z-50 min-w-[200px] py-1">
                        {AIPanelProviderOptions.map((opt) => {
                            const isSelected = opt.key === provider;
                            return (
                                <button
                                    key={opt.key}
                                    onClick={() => handleSelect(opt.key)}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors text-left"
                                >
                                    <i className={cn("fa", opt.icon, "w-4 text-center text-accent")}></i>
                                    <span className={cn("text-sm", isSelected && "font-bold")}>{opt.label}</span>
                                    {isSelected && <i className="fa fa-check ml-auto text-xs"></i>}
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
});

AIProviderDropdown.displayName = "AIProviderDropdown";
