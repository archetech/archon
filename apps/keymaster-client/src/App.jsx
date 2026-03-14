import React, { useState } from 'react';
import KeymasterClient from '@didcid/keymaster/client';
import KeymasterUI from './KeymasterUI.jsx';
import LoginModal from './LoginModal.jsx';
import './App.css';

const STORAGE_KEY = 'KEYMASTER_URL';
const defaultPort = import.meta.env.VITE_SERVER_PORT || '4226';
const defaultUrl = `${window.location.protocol}//${window.location.hostname}:${defaultPort}`;
const keymasterUrl = localStorage.getItem(STORAGE_KEY) || defaultUrl;

function App() {
    const [keymaster, setKeymaster] = useState(null);
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
            await km.connect({ url: keymasterUrl });
            if (adminApiKey) {
                km.addCustomHeader('Authorization', `Bearer ${adminApiKey}`);
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
                    serverUrl={keymasterUrl}
                    onServerUrlChange={handleServerUrlChange}
                />
            )}
        </>
    );
}

export default App;
