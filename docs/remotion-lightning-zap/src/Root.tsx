import React from 'react';
import {Composition} from 'remotion';
import {LightningZapVideo} from './LightningZapVideo';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="LightningZap"
      component={LightningZapVideo}
      durationInFrames={1800}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{}}
    />
  );
};
