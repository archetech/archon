import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ContextProviders } from "./contexts/ContextProviders";
import PopupContent from "./components/PopupContent";
import NostrApproval from "./components/NostrApproval";
import "./static/extension.css";

const params = new URLSearchParams(window.location.search);
const nostrRequestId = params.get("nostrRequest");

const PopupUI = () => {
    const [pendingAuth, setPendingAuth] = useState<string>("");
    const [pendingCredential, setPendingCredential] = useState<string>("");

    useEffect(() => {
        if (nostrRequestId) {
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
                <NostrApproval requestId={nostrRequestId} />
            </ContextProviders>
        );
    }

    return (
        <ContextProviders pendingCredential={pendingCredential} pendingAuth={pendingAuth} isBrowser={false}>
            <PopupContent />
        </ContextProviders>
    );
};

const rootElement = document.createElement("div");
document.body.appendChild(rootElement);
const root = ReactDOM.createRoot(rootElement);
root.render(<PopupUI />);
