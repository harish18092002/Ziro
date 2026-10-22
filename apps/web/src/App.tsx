import { useEffect, useState } from 'react';

interface Health {
  status: string;
  checks?: Record<string, string>;
}

// Placeholder shell: the review console lands with the review module.
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/health')
      .then(async (res) => {
        setHealth((await res.json()) as Health);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '3rem auto' }}>
      <h1>Ziro</h1>
      <p>Every paisa, accounted for.</p>
      <h2>API health</h2>
      {error ? <pre>unreachable: {error}</pre> : <pre>{JSON.stringify(health, null, 2)}</pre>}
    </main>
  );
}
