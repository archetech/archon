import React, { useState } from 'react';
import KeymasterClient from '@didcid/keymaster/client';
import KeymasterUI from './KeymasterUI.jsx';
import LoginModal from './LoginModal.jsx';
import './App.css';

const keymasterUrl = import.meta.env.VITE_KEYMASTER_URL || 'http://localhost:4226';

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
