import React, { useState, useEffect } from 'react';
import KeymasterClient from '@didcid/keymaster/client';
import KeymasterUI from './KeymasterUI.js';
import LoginModal from './LoginModal.js';
import './App.css';

function App() {
    const [keymaster, setKeymaster] = useState(null);
    const [showLogin, setShowLogin] = useState(false);
    const [loginError, setLoginError] = useState('');

    useEffect(() => {
        const passphraseRequired = window.__ARCHON_CONFIG__?.passphraseRequired;

        if (passphraseRequired) {
            setShowLogin(true);
        } else {
            // Dev mode — get key (if any) without passphrase
            login();
        }
    }, []);

    async function login(passphrase) {
        setLoginError('');

        try {
            const res = await fetch('/api/v1/login', {
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
            if (adminApiKey) {
                km.addCustomHeader('Authorization', `Bearer ${adminApiKey}`);
            }
            setShowLogin(false);
            setKeymaster(km);
        } catch {
            setLoginError('Could not connect to server');
        }
    }

    return (
        <>
            <LoginModal
                isOpen={showLogin}
                errorText={loginError}
                onSubmit={login}
            />
            {keymaster && (
                <KeymasterUI keymaster={keymaster} title={'Keymaster Server Wallet Demo'} />
            )}
        </>
    );
}

export default App;
