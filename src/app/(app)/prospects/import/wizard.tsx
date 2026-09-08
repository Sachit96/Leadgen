'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { ImportPreview } from '@/lib/services/import';
import { formatPhone } from '@/lib/core/phone';
import { Card, EmptyState, Stat, Table, Td, Th, cn, selectClass } from '@/components/ui/primitives';
import { Button } from '@/components/ui/buttons';
import { useToast } from '@/components/ui/toast';
import { commitImportAction, previewImportAction } from '@/app/actions/prospects';

/**
 * Import is deliberately two-phase.
 *
 * The preview runs the same parser and duplicate detection the commit will use,
 * so what the operator sees is what will happen — including which rows are
 * unusable and why, before a single row is written.
 */
export function ImportWizard({ campaigns }: { campaigns: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('import.csv');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const readFile = async (file: File) => {
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    setPreview(null);
  };

  const runPreview = () => {
    if (!csv.trim()) {
      toast.push('Paste or upload a CSV first', 'error');
      return;
    }
    const form = new FormData();
    form.set('csv', csv);
    startTransition(async () => {
      const result = await previewImportAction(form);
      if (result.ok) setPreview(result.data as ImportPreview);
      else toast.push(result.error, 'error');
    });
  };

  const commit = () => {
    const form = new FormData();
    form.set('csv', csv);
    form.set('filename', filename);
    if (updateExisting) form.set('updateExisting', 'on');
    if (campaignId) form.set('campaignId', campaignId);

    startTransition(async () => {
      const result = await commitImportAction(form);
      if (result.ok) {
        toast.push(
          `Imported ${result.data.created} prospect${result.data.created === 1 ? '' : 's'}`,
          'success',
        );
        router.push('/prospects');
      } else {
        toast.push(result.error, 'error');
      }
    });
  };

  return (
    <div className="space-y-5">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <Button onClick={() => fileInput.current?.click()}>Choose CSV file</Button>
          <span className="text-xs text-ink-500">
            {csv ? `${filename} · ${csv.split('\n').length - 1} rows` : 'or paste below'}
          </span>
        </div>

        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setPreview(null);
          }}
          rows={6}
          spellCheck={false}
          placeholder={'Business Name,Owner,Phone Number,City,Industry,Google Reviews\nSummit Ridge Roofing,Mike Delaney,(416) 555-0142,Mississauga,Roofing,187'}
          aria-label="CSV content"
          className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs text-ink-200 placeholder:text-ink-600 focus:border-accent-500 focus:outline-none"
        />

        <div className="flex justify-end">
          <Button variant="primary" onClick={runPreview} disabled={pending || !csv.trim()}>
            {pending ? 'Checking…' : 'Preview import'}
          </Button>
        </div>
      </Card>

      {preview ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Rows in file" value={preview.totalRows} />
            <Stat label="Will be created" value={preview.validRows} tone="positive" />
            <Stat label="Already in CRM" value={preview.duplicateRows} tone="warning" />
            <Stat label="Cannot import" value={preview.errorRows} tone={preview.errorRows > 0 ? 'danger' : 'neutral'} />
          </div>

          <Card>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-400">
              Column mapping
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {Object.entries(preview.mapping).map(([field, index]) => (
                <span key={field} className="text-xs text-ink-300">
                  <span className="text-ink-500">{field}</span> ← {preview.headers[index]}
                </span>
              ))}
            </div>
            {Object.keys(preview.mapping).length === 0 ? (
              <p className="text-xs text-ink-500">No columns could be mapped automatically.</p>
            ) : null}
          </Card>

          {preview.rows.length === 0 ? (
            <EmptyState title="Nothing to preview" />
          ) : (
            <div>
              <p className="mb-2 text-xs text-ink-500">
                Showing the first {preview.rows.length} rows.
              </p>
              <Table className="min-w-[800px]">
                <thead>
                  <tr>
                    <Th className="w-12">Row</Th>
                    <Th>Company</Th>
                    <Th>Contact</Th>
                    <Th>Phone</Th>
                    <Th>City</Th>
                    <Th>Outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber} className={cn(row.error && 'bg-danger-500/5')}>
                      <Td className="tabular-nums text-ink-500">{row.rowNumber}</Td>
                      <Td>{row.companyName ?? '—'}</Td>
                      <Td className="text-ink-300">
                        {[row.firstName, row.lastName].filter(Boolean).join(' ') || '—'}
                      </Td>
                      <Td className="tabular-nums text-ink-300">
                        {row.phone ? formatPhone(row.phone) : (row.phoneRaw ?? '—')}
                      </Td>
                      <Td className="text-ink-400">{row.city ?? '—'}</Td>
                      <Td>
                        {row.error ? (
                          <span className="text-xs text-danger-400">{row.error}</span>
                        ) : row.duplicateOf ? (
                          <span className="text-xs text-warning-400">
                            {updateExisting ? 'Will fill in blanks' : 'Already exists — skipped'}
                          </span>
                        ) : (
                          <span className="text-xs text-positive-400">Will be created</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}

          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-ink-300">
                <input
                  type="checkbox"
                  checked={updateExisting}
                  onChange={(e) => setUpdateExisting(e.target.checked)}
                  className="size-3.5 accent-blue-500"
                />
                Fill in blanks on prospects that already exist
              </label>

              <select
                aria-label="Add imported prospects to a campaign"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className={cn(selectClass, 'w-auto')}
              >
                <option value="">Do not add to a campaign</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    Add to: {campaign.name}
                  </option>
                ))}
              </select>
            </div>

            <Button
              variant="primary"
              onClick={commit}
              disabled={pending || preview.validRows + (updateExisting ? preview.duplicateRows : 0) === 0}
            >
              {pending ? 'Importing…' : `Import ${preview.validRows} prospect${preview.validRows === 1 ? '' : 's'}`}
            </Button>
          </Card>
        </>
      ) : null}
    </div>
  );
}
