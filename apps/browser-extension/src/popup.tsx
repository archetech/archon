import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ContextProviders } from "./contexts/ContextProviders";
import PopupContent from "./components/PopupContent";
import NostrApproval from "./components/NostrApproval";
import "./static/extension.css";

const params = new URLSearchParams(window.location.search);
const nostrRequestId = params.get("nostrRequest");
const nostrAutoApprove = params.get("autoApprove") === "true";
const urlChallenge = params.get("challenge") || "";
const urlCredential = params.get("credential");
const urlAlias = params.get("alias") || "";
const urlAliasDid = params.get("did") || "";

const PopupUI = () => {
    const [pendingAuth, setPendingAuth] = useState<string>(urlChallenge);
    const [pendingCredential, setPendingCredential] = useState<string>(
        urlCredential ? JSON.parse(decodeURIComponent(urlCredential)) : ""
    );
    const [pendingAlias, setPendingAlias] = useState<{ alias: string; did: string } | undefined>(
        urlAlias && urlAliasDid ? { alias: urlAlias, did: urlAliasDid } : undefined
    );

    useEffect(() => {
        if (nostrRequestId || urlChallenge || urlCredential || (urlAlias && urlAliasDid)) {
            return;
        }
        const handleMessage = (
            message: any,
            _: chrome.runtime.MessageSender,
            sendResponse: (response?: any) => void
        ) => {
            if (message.action === "SHOW_POPUP_AUTH") {
                setPendingAuth(message.challenge);
                sendResponse({ success: true });
            } else if (message.action === "SHOW_POPUP_CREDENTIAL") {
                setPendingCredential(message.credential);
                sendResponse({ success: true });
            } else if (message.action === "SHOW_POPUP_ALIAS") {
                setPendingAlias({ alias: message.alias, did: message.did });
                sendResponse({ success: true });
            }
        };
        chrome.runtime.onMessage.addListener(handleMessage);

        return () => {
            chrome.runtime.onMessage.removeListener(handleMessage);
        };
    }, []);

    if (nostrRequestId) {
        return (
            <ContextProviders isBrowser={false}>
                <NostrApproval requestId={nostrRequestId} autoApprove={nostrAutoApprove} />
            </ContextProviders>
        );
    }

    return (
        <ContextProviders pendingCredential={pendingCredential} pendingAuth={pendingAuth} pendingAlias={pendingAlias} isBrowser={false}>
            <PopupContent />
        </ContextProviders>
    );
};

const rootElement = document.createElement("div");
document.body.appendChild(rootElement);
const root = ReactDOM.createRoot(rootElement);
root.render(<PopupUI />);
