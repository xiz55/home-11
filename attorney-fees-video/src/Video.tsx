import {Audio} from '@remotion/media';
import {AbsoluteFill, Sequence, staticFile} from 'remotion';
import {Background} from './components/Background';
import {Caption} from './components/Caption';
import {Header} from './components/Header';
import {Contract} from './scenes/Contract';
import {Example} from './scenes/Example';
import {Factors} from './scenes/Factors';
import {Hook} from './scenes/Hook';
import {Methods} from './scenes/Methods';
import {Outro} from './scenes/Outro';
import {Tips} from './scenes/Tips';
import {SceneId, sceneOf} from './timing';

const SCENES: {id: SceneId; name: string; Component: React.FC<{duration: number}>}[] = [
	{id: 'hook', name: 'الافتتاح', Component: Hook},
	{id: 'contract', name: 'العقد المكتوب', Component: Contract},
	{id: 'methods', name: 'طرق الحساب', Component: Methods},
	{id: 'factors', name: 'العوامل المؤثرة', Component: Factors},
	{id: 'example', name: 'المثال الحسابي', Component: Example},
	{id: 'tips', name: 'نصائح قبل التوقيع', Component: Tips},
	{id: 'outro', name: 'الختام', Component: Outro},
];

export const AttorneyFees: React.FC = () => {
	return (
		<AbsoluteFill>
			<Background />
			{SCENES.map(({id, name, Component}) => {
				const scene = sceneOf(id);
				return (
					<Sequence key={id} name={name} from={scene.from} durationInFrames={scene.duration}>
						<Component duration={scene.duration} />
					</Sequence>
				);
			})}
			<Header />
			<Caption />
			<Audio src={staticFile('voiceover/voiceover.mp3')} />
		</AbsoluteFill>
	);
};
