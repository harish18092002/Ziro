import { useState } from 'react';
import { Icon } from './Icons';

type CopyState = 'idle' | 'done' | 'failed';

/** Copies text and says so for two seconds. When the browser refuses, it says that instead. */
function useCopy(text: string): [CopyState, () => void] {
  const [state, setState] = useState<CopyState>('idle');
  const copy = () => {
    const finish = (next: CopyState) => {
      setState(next);
      setTimeout(() => setState('idle'), 2000);
    };
    navigator.clipboard.writeText(text).then(
      () => finish('done'),
      () => finish('failed'),
    );
  };
  return [state, copy];
}

/** A few lines of text to paste somewhere, with a Copy button. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [state, copy] = useCopy(text);
  return (
    <div className="copyblock">
      <pre>
        <code>{text}</code>
      </pre>
      <button type="button" className="sm" onClick={copy} aria-label={`Copy ${label}`}>
        {state === 'done' ? (
          <>
            <Icon name="check" size={14} /> Copied
          </>
        ) : state === 'failed' ? (
          'Select and copy'
        ) : (
          <>
            <Icon name="file" size={14} /> Copy
          </>
        )}
      </button>
    </div>
  );
}

/** One short value to type somewhere, shown in code type with a small copy button beside it. */
export function CopyChip({ text, label }: { text: string; label: string }) {
  const [state, copy] = useCopy(text);
  return (
    <span className="copychip">
      <code>{text}</code>
      <button
        type="button"
        className="ghost sm"
        onClick={copy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        <Icon name={state === 'done' ? 'check' : 'file'} size={13} />
        <span className="sr-only">{state === 'done' ? 'Copied' : 'Copy'}</span>
      </button>
    </span>
  );
}
