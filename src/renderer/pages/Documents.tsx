import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp, useAsync } from '../state';
import { RecordForm } from '../RecordForm';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Icon, Modal, PageHeader, Panel, SearchInput, Select } from '../ui';
import { bytes, fmtDateTime } from '../format';
import { DOCUMENT_KINDS } from '../../shared/constants';

export default function DocumentsPage() {
  const { projectId, project, notify, confirm, refresh, route } = useApp();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [uploading, setUploading] = useState(false);

  const docs = useAsync(
    () => api.list('document', { where: { project_id: projectId, ...(kind ? { kind } : {}) }, q: search || undefined, limit: 1000, orderBy: 'created_at', order: 'desc' }),
    [projectId, search, kind],
  );

  const openPreview = async (id: string) => {
    try {
      setPreview(await api.documentPreview(id));
    } catch (err: any) {
      notify(err.message, 'error');
    }
  };

  useEffect(() => {
    if (route.query.doc) void openPreview(route.query.doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.query.doc]);

  if (!projectId) return <EmptyState title="Select a project" icon="folder" />;

  const upload = async () => {
    const picked = await api.pickOpen({ title: 'Upload documents', multi: true });
    if (picked.canceled || !picked.paths?.length) return;
    setUploading(true);
    try {
      await api.uploadDocuments({ projectId, entityType: 'project', entityId: projectId, paths: picked.paths, kind: 'Other', description: '' });
      notify(`${picked.paths.length} document(s) added to the library`, 'success');
      docs.reload();
      refresh();
    } catch (err: any) {
      notify(err.message, 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Engineering Documentation"
        subtitle={`${project?.name ?? ''} · datasheets, procedures, measurement records, images and notes — original files are retained`}
        actions={
          <>
            <Button icon="upload" variant="primary" onClick={upload} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload documents'}
            </Button>
          </>
        }
      />

      <Panel
        title={`Document library (${docs.data?.length ?? 0})`}
        actions={
          <div className="toolbar-inline">
            <Select value={kind} onChange={setKind} placeholder="All kinds" options={DOCUMENT_KINDS.map((k) => ({ value: k, label: k }))} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search titles, tags, filenames…" />
          </div>
        }
        dense
      >
        {docs.error && <ErrorBox message={docs.error} onRetry={docs.reload} />}
        <DataTable
          rows={docs.data ?? []}
          onRowClick={(d) => openPreview(d.id)}
          columns={[
            { key: 'title', label: 'Document', render: (d) => <span className="link-like">{d.title}</span> },
            { key: 'kind', label: 'Kind', width: '150px', render: (d) => <Badge>{d.kind}</Badge> },
            { key: 'original_name', label: 'File', render: (d) => <span className="mono small">{d.original_name}</span> },
            { key: 'size', label: 'Size', align: 'right', render: (d) => bytes(d.size), width: '90px' },
            { key: 'entity_type', label: 'Attached to', render: (d) => d.entity_type || 'project' },
            { key: 'tags', label: 'Tags' },
            { key: 'created_at', label: 'Added', render: (d) => fmtDateTime(d.created_at), width: '150px' },
            {
              key: 'actions',
              label: '',
              align: 'right',
              width: '120px',
              render: (d) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Open" onClick={() => api.openPath(d.stored_path).catch((e) => notify(e.message, 'error'))}>
                    <Icon name="link" size={14} />
                  </button>
                  <button className="icon-btn" title="Show in folder" onClick={() => api.reveal(d.stored_path).catch((e) => notify(e.message, 'error'))}>
                    <Icon name="folder" size={14} />
                  </button>
                  <button className="icon-btn" title="Edit metadata" onClick={() => setEditing({ ...d })}>
                    <Icon name="edit" size={14} />
                  </button>
                </div>
              ),
            },
          ]}
          empty={<EmptyState title="No documents" message="Upload datasheets, test procedures, reports or images." icon="doc" action={<Button variant="primary" icon="upload" onClick={upload}>Upload documents</Button>} />}
        />
      </Panel>

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} size="lg">
          <div className="stack">
            <div className="doc-meta">
              <Badge>{preview.kind}</Badge>
              <span className="mono small">{preview.original_name}</span>
              <span className="muted small">{bytes(preview.size)}</span>
              <span className="muted small">SHA-256 {preview.checksum?.slice(0, 16)}…</span>
            </div>
            {preview.description && <p>{preview.description}</p>}
            {preview.preview?.kind === 'image' && <img className="doc-image" src={preview.preview.dataUrl} alt={preview.title} />}
            {preview.preview?.kind === 'text' && <pre className="code-block scroll">{preview.preview.text}</pre>}
            {preview.preview?.kind === 'unsupported' && <div className="muted">Preview is not available for this format. Open it with the system viewer.</div>}
            {preview.missing && <div className="error-box">The stored file is missing.</div>}
            <div className="modal-actions-row">
              <Button icon="link" onClick={() => api.openPath(preview.stored_path)}>Open with system viewer</Button>
              <Button icon="folder" onClick={() => api.reveal(preview.stored_path)}>Show in folder</Button>
              <Button icon="edit" onClick={() => { setEditing({ ...preview }); setPreview(null); }}>Edit metadata</Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  const ok = await confirm({ title: 'Remove document?', message: preview.title, details: 'The stored file remains on disk for recovery.', confirmLabel: 'Remove record', danger: true });
                  if (!ok) return;
                  await api.removeDocument(preview.id, false);
                  setPreview(null);
                  docs.reload();
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal
          title="Document metadata"
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await api.update('document', editing.id, {
                    title: editing.title,
                    kind: editing.kind,
                    tags: editing.tags,
                    description: editing.description,
                  });
                  setEditing(null);
                  docs.reload();
                  notify('Document metadata updated', 'success');
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <RecordForm
            entity="document"
            value={editing}
            projectId={projectId}
            onChange={(patch) => setEditing((d: any) => ({ ...d, ...patch }))}
          />
        </Modal>
      )}
    </div>
  );
}
