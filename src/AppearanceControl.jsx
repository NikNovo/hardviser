import { useId, useSyncExternalStore } from 'react';
import {
  getAppearanceSnapshot,
  setAppearancePreference,
  subscribeAppearance,
} from './appearance.js';

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function AppearanceControl() {
  const id = useId();
  const { preference, persistence } = useSyncExternalStore(
    subscribeAppearance,
    getAppearanceSnapshot,
    getAppearanceSnapshot,
  );

  return <section className="appearance-control" aria-labelledby={`${id}-heading`}>
    <h2 className="appearance-control__heading" id={`${id}-heading`}>Appearance</h2>
    <div className="appearance-control__options" role="group" aria-labelledby={`${id}-heading`}>
      {OPTIONS.map(option => <button
        className="appearance-control__button"
        type="button"
        key={option.value}
        aria-pressed={preference === option.value}
        onClick={() => setAppearancePreference(option.value)}
      >{option.label}</button>)}
    </div>
    <p className={persistence === 'memory' ? 'appearance-control__status' : 'appearance-control__description'} role={persistence === 'memory' ? 'status' : undefined}>
      {persistence === 'memory' ? 'Not saved — only for this session.' : 'Changes stay in this browser.'}
    </p>
  </section>;
}
