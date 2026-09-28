import React from 'react';
import { Composition } from 'remotion';
import { CredentialVerificationVideo, DURATION } from './Video';
import { FPS } from './theme';

export const RemotionRoot: React.FC = () => (
    <Composition
        id="CredentialVerification"
        component={CredentialVerificationVideo}
        durationInFrames={DURATION}
        fps={FPS}
        width={1920}
        height={1080}
    />
);
