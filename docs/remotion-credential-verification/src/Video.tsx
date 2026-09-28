import React from 'react';
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { Cast, CAST_FRAMES, Title, TITLE_FRAMES } from './scenes/Intro';
import { CHALLENGE_FRAMES, ChallengeScene, Issuance, ISSUANCE_FRAMES, RESPONSE_FRAMES, ResponseScene } from './scenes/Flow';
import { Checks, CHECKS_FRAMES } from './scenes/Checks';
import { History, HISTORY_FRAMES, Outro, OUTRO_FRAMES, Pairing, PAIRING_FRAMES } from './scenes/Closing';

const TRANSITION = 18;

const scenes: { Scene: React.FC, frames: number }[] = [
    { Scene: Title, frames: TITLE_FRAMES },
    { Scene: Cast, frames: CAST_FRAMES },
    { Scene: Issuance, frames: ISSUANCE_FRAMES },
    { Scene: ChallengeScene, frames: CHALLENGE_FRAMES },
    { Scene: ResponseScene, frames: RESPONSE_FRAMES },
    { Scene: Checks, frames: CHECKS_FRAMES },
    { Scene: Pairing, frames: PAIRING_FRAMES },
    { Scene: History, frames: HISTORY_FRAMES },
    { Scene: Outro, frames: OUTRO_FRAMES },
];

// Each transition overlaps the scenes on either side of it.
export const DURATION = scenes.reduce((total, { frames }) => total + frames, 0) - TRANSITION * (scenes.length - 1);

export const CredentialVerificationVideo: React.FC = () => (
    <TransitionSeries>
        {scenes.map(({ Scene, frames }, index) => (
            <React.Fragment key={index}>
                {index > 0 && (
                    <TransitionSeries.Transition
                        presentation={index % 3 === 0 ? slide({ direction: 'from-right' }) : fade()}
                        timing={linearTiming({ durationInFrames: TRANSITION })}
                    />
                )}
                <TransitionSeries.Sequence durationInFrames={frames}>
                    <Scene />
                </TransitionSeries.Sequence>
            </React.Fragment>
        ))}
    </TransitionSeries>
);
