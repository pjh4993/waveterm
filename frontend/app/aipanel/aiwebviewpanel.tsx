// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi } from "@/app/store/global";
import { cn } from "@/util/util";
import { memo, useRef } from "react";
import { AIProviderDropdown } from "./aiproviderdropdown";
import { AIWebProvider } from "./aiwebproviders";

const AIWebviewHeader = memo(
    ({ provider, onReload, onHome }: { provider: AIWebProvider; onReload: () => void; onHome: () => void }) => {
        const openDesktopApp = () => {
            if (!provider.appUrl) return;
            getApi().openExternal(provider.appUrl);
        };
        return (
            <div className="py-1 pl-2 pr-1 @xs:pl-3 border-b border-gray-600 flex items-center justify-between min-w-0">
                <AIProviderDropdown />
                <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                        onClick={onHome}
                        className="text-gray-400 hover:text-white cursor-pointer transition-colors p-1 rounded"
                        title="Home"
                    >
                        <i className="fa fa-house"></i>
                    </button>
                    <button
                        onClick={onReload}
                        className="text-gray-400 hover:text-white cursor-pointer transition-colors p-1 rounded"
                        title="Reload"
                    >
                        <i className="fa fa-rotate-right"></i>
                    </button>
                    {provider.appUrl && (
                        <button
                            onClick={openDesktopApp}
                            className="text-gray-400 hover:text-white cursor-pointer transition-colors p-1 rounded"
                            title={`Open ${provider.label} desktop app`}
                        >
                            <i className="fa fa-up-right-from-square"></i>
                        </button>
                    )}
                </div>
            </div>
        );
    }
);

AIWebviewHeader.displayName = "AIWebviewHeader";

const AIWebviewPanelInner = memo(({ roundTopLeft, provider }: { roundTopLeft: boolean; provider: AIWebProvider }) => {
    const webviewRef = useRef<Electron.WebviewTag>(null);
    const preload = getApi().getWebviewPreload();

    const handleReload = () => {
        webviewRef.current?.reload();
    };
    const handleHome = () => {
        webviewRef.current?.loadURL(provider.url);
    };

    return (
        <div
            data-aipanel="true"
            className={cn(
                "@container bg-zinc-900/70 flex flex-col relative mt-1 h-[calc(100%-4px)] border-2 border-transparent"
            )}
            style={{
                borderTopLeftRadius: roundTopLeft ? 10 : 0,
                borderTopRightRadius: 10,
                borderBottomRightRadius: 10,
                borderBottomLeftRadius: 10,
            }}
        >
            <AIWebviewHeader provider={provider} onReload={handleReload} onHome={handleHome} />
            <webview
                id={`aiweb-${provider.key}`}
                ref={webviewRef}
                className="flex-1 min-h-0 w-full"
                src={provider.url}
                preload={preload}
                partition={provider.partition}
                // @ts-expect-error Chromium webviewTag expects a string here, React types expect a boolean
                allowpopups="true"
            />
        </div>
    );
});

AIWebviewPanelInner.displayName = "AIWebviewPanelInner";

export const AIWebviewPanel = ({ roundTopLeft, provider }: { roundTopLeft: boolean; provider: AIWebProvider }) => {
    return <AIWebviewPanelInner roundTopLeft={roundTopLeft} provider={provider} />;
};

AIWebviewPanel.displayName = "AIWebviewPanel";
