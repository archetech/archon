import KeymasterClient from '@didcid/keymaster/client';
import KeymasterUI from './KeymasterUI.js';
import './App.css';

function App() {
    const keymaster = new KeymasterClient();
    const apiKey = window.__ARCHON_CONFIG__?.adminApiKey;
    if (apiKey) {
        keymaster.addCustomHeader('Authorization', `Bearer ${apiKey}`);
    }
    return (
        <KeymasterUI keymaster={keymaster} title={'Keymaster Server Wallet Demo'} />
    );
}

export default App;
