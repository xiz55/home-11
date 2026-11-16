import {Composition} from 'remotion';
import {FPS, totalFrames} from './timing';
import {AttorneyFees} from './Video';

export const RemotionRoot: React.FC = () => {
	return (
		<Composition
			id="AttorneyFees"
			component={AttorneyFees}
			durationInFrames={totalFrames}
			fps={FPS}
			width={1080}
			height={1920}
		/>
	);
};
