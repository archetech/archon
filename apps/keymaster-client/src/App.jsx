import React, { useState } from 'react';
import KeymasterClient from '@didcid/clients/keymaster';
import KeymasterUI from './KeymasterUI.jsx';
import LoginModal from './LoginModal.jsx';
import './App.css';

const STORAGE_KEY = 'KEYMASTER_URL';
const defaultPort = import.meta.env.VITE_SERVER_PORT || '4226';
const defaultUrl = `${window.location.protocol}//${window.location.hostname}:${defaultPort}`;
const keymasterUrl = localStorage.getItem(STORAGE_KEY) || defaultUrl;

function App() {
    const [keymaster, setKeymaster] = useState(null);
    // Unknown (a node serving no capability manifest) is permissive, matching the
    // gate inside Keymaster: show the surface rather than hide it against an
    // older node, and let the operation fail late if the service really is absent.
    const [hasDidComm, setHasDidComm] = useState(true);
    const [showLogin, setShowLogin] = useState(true);
    const [loginError, setLoginError] = useState('');

    async function login(passphrase) {
        setLoginError('');

        try {
            const res = await fetch(`${keymasterUrl}/api/v1/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passphrase }),
            });

            if (!res.ok) {
                const data = await res.json();
                setLoginError(data.error || 'Login failed');
                return;
            }

            const { adminApiKey } = await res.json();
            const km = new KeymasterClient();
            // The admin key goes in X-Archon-Admin-Key, which is the only header
            // the keymaster service reads; connect installs it. It was previously
            // sent as an Authorization bearer token, which the service ignores, so
            // every protected call 401'd whenever ARCHON_ADMIN_API_KEY was set.
            await km.connect({ url: keymasterUrl, apiKey: adminApiKey });
            try {
                const capabilities = await km.getNodeCapabilities();
                setHasDidComm(capabilities?.didcomm !== false);
            } catch {
                // Capability manifest unreadable — leave DIDComm visible.
            }

            setShowLogin(false);
            setKeymaster(km);
        } catch {
            setLoginError('Could not connect to server');
        }
    }

    function handleServerUrlChange(newUrl) {
        localStorage.setItem(STORAGE_KEY, newUrl);
        window.location.reload();
    }

    return (
        <>
            <LoginModal
                isOpen={showLogin}
                errorText={loginError}
                onSubmit={login}
                serverUrl={keymasterUrl}
                onServerUrlChange={handleServerUrlChange}
            />
            {keymaster && (
                <KeymasterUI
                    keymaster={keymaster}
                    title={'Keymaster Server Wallet Demo'}
                    hasDidComm={hasDidComm}
                    serverUrl={keymasterUrl}
                    onServerUrlChange={handleServerUrlChange}
                />
            )}
        </>
    );
}

export default App;
