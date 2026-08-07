import { config } from '../../lib/config';

export const dynamic = 'force-dynamic';

interface OpsRootError {
  path: string;
  error: string;
  last_seen: string;
}

interface OpsSource {
  root: string;
  origin: string;
  last_run: string | null;
  files_seen: number;
  files_indexed: number;
  pending: number;
  errors: OpsRootError[];
}

interface OpsIngestLogRow {
  id: string;
  run_id: string;
  stage: string;
  path: string | null;
  at: string;
}

interface OpsResponse {
  sources: OpsSource[];
  ingest_log: OpsIngestLogRow[];
}

async function fetchOps(): Promise<{ data: OpsResponse | null; error: string | null }> {
  try {
    const res = await fetch(`${config.quillApiUrl}/ops`, { cache: 'no-store' });
    if (!res.ok) {
      return { data: null, error: `quill-api /ops returned ${res.status}` };
    }
    return { data: (await res.json()) as OpsResponse, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'quill-api unreachable' };
  }
}

export default async function OpsPage() {
  const { data, error } = await fetchOps();

  return (
    <div className="q-page">
      <div className="q-page__head">
        <div>
          <h1 className="q-page__title">Sync state</h1>
          <p className="q-page__sub">Per-root ingest status from quill-api /ops.</p>
        </div>
      </div>

      {error && <div className="q-alert q-alert--error">{error}</div>}

      {data && (
        <>
          <div className="q-card q-card--table">
            <div className="q-tablewrap">
              <table className="q-table">
                <thead>
                  <tr>
                    <th>Root</th>
                    <th>Origin</th>
                    <th>Last indexed</th>
                    <th className="quill-tnum">Files seen</th>
                    <th className="quill-tnum">Indexed</th>
                    <th className="quill-tnum">Pending</th>
                    <th className="quill-tnum">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sources.length === 0 && (
                    <tr>
                      <td colSpan={7} className="q-empty">
                        No roots reported yet.
                      </td>
                    </tr>
                  )}
                  {data.sources.map((source) => (
                    <tr key={`${source.root}::${source.origin}`}>
                      <td className="q-mono">{source.root}</td>
                      <td>{source.origin}</td>
                      <td className="quill-tnum">{source.last_run ? new Date(source.last_run).toLocaleString() : '—'}</td>
                      <td className="quill-tnum">{source.files_seen}</td>
                      <td className="quill-tnum">{source.files_indexed}</td>
                      <td className="quill-tnum">{source.pending}</td>
                      <td className="quill-tnum">{source.errors.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data.sources.some((s) => s.errors.length > 0) && (
            <div className="q-card">
              <h2 className="q-card__title">Recent errors</h2>
              <ul className="q-errorlist">
                {data.sources.flatMap((source) =>
                  source.errors.map((err) => (
                    <li key={`${source.root}::${err.path}`}>
                      <span className="q-mono">{err.path}</span>
                      <span className="q-errorlist__msg">{err.error}</span>
                      <span className="quill-tnum q-errorlist__ts">{new Date(err.last_seen).toLocaleString()}</span>
                    </li>
                  )),
                )}
              </ul>
            </div>
          )}

          <div className="q-card">
            <h2 className="q-card__title">Recent ingest log</h2>
            <ul className="q-loglist">
              {data.ingest_log.length === 0 && <li className="q-empty">No log entries yet.</li>}
              {data.ingest_log.map((row) => (
                <li key={row.id}>
                  <span className="quill-tnum q-loglist__ts">{new Date(row.at).toLocaleString()}</span>
                  <span className="q-loglist__stage">{row.stage}</span>
                  <span className="q-mono">{row.path ?? row.run_id}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
