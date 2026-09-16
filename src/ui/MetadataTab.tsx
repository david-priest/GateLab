// MetadataTab.tsx — two editable metadata tables (hand-rolled, no table library):
//  • Sample metadata: rows = loaded samples; derived Events/Ch/Instr + user fields. These drive the
//    Proportions tab's Group / Unit / Facet. Imported from CSV/TSV joined on FCS filename.
//  • Population metadata: rows = gated populations; derived Parent / Count / % Parent + user fields
//    (annotation — lineage, class, note…). Keyed by population id, so it survives renames.
// Both tables share <EditableMetaTable>. GateLab's colData-free stand-in.

import type { Sample } from "../engine/sample";
import type { MetadataColumn } from "../engine/metadata";
import { SAMPLE_ID_FIELD, sampleDisplayId } from "../engine/metadata";
import { EditableMetaTable, type MetaRow } from "./EditableMetaTable";
import { useI18n } from "./i18n";

interface SampleRef {
  id: string;
  name: string;
  sample: Sample;
}
interface Props {
  // Sample metadata
  samples: SampleRef[];
  metadata: Record<string, Record<string, string>>;
  columns: MetadataColumn[];
  onSetCell: (sampleId: string, field: string, value: string) => void;
  onAddColumn: (name: string) => void;
  onRenameColumn: (oldName: string, newName: string) => void;
  onDeleteColumn: (name: string) => void;
  onImport: (file: File) => void;
  // Population metadata
  populationRows: MetaRow[];
  populationMetadata: Record<string, Record<string, string>>;
  populationColumns: MetadataColumn[];
  onSetPopCell: (popId: string, field: string, value: string) => void;
  onAddPopColumn: (name: string) => void;
  onRenamePopColumn: (oldName: string, newName: string) => void;
  onDeletePopColumn: (name: string) => void;
  onWriteSampleMetadataToHost?: () => void;
  hostWriteBusy?: boolean;
}

export function MetadataTab({
  samples, metadata, columns, onSetCell, onAddColumn, onRenameColumn, onDeleteColumn, onImport,
  populationRows, populationMetadata, populationColumns, onSetPopCell, onAddPopColumn, onRenamePopColumn, onDeletePopColumn,
  onWriteSampleMetadataToHost, hostWriteBusy = false,
}: Props) {
  const { t } = useI18n();
  const sampleRows: MetaRow[] = samples.map((s) => ({
    id: s.id,
    name: s.name,
    fixed: [s.sample.fcs.nEvents.toLocaleString(), s.sample.channels.length, s.sample.instrument],
  }));

  return (
    <div className="gl-tab-panel">
      {onWriteSampleMetadataToHost && (
        <div className="gl-tab-head">
          <div>
            <h2 className="gl-tab-title">{t("SingleCellExperiment metadata")}</h2>
            <p className="gl-hint gl-panel-hint">
              {t("Write the sample-level fields below across the corresponding events in SCE colData. Existing columns require explicit overwrite confirmation.")}
            </p>
          </div>
          <button
            type="button"
            className="gl-btn-primary"
            disabled={hostWriteBusy || columns.length === 0}
            onClick={onWriteSampleMetadataToHost}
          >
            {hostWriteBusy ? t("Writing…") : t("Write sample metadata to SCE")}
          </button>
        </div>
      )}
      <EditableMetaTable
        title={t("Sample metadata")}
        rowHeader={t("Filename (read-only)")}
        fixedHeaders={[t("Events"), t("Ch"), t("Instr.")]}
        rows={sampleRows}
        columns={[{ name: SAMPLE_ID_FIELD }, ...columns.filter(column => column.name !== SAMPLE_ID_FIELD)]}
        protectedColumns={[SAMPLE_ID_FIELD]}
        values={Object.fromEntries(samples.map(file => [file.id, { ...metadata[file.id], [SAMPLE_ID_FIELD]: sampleDisplayId(file.name, metadata[file.id]) }]))}
        onSetCell={onSetCell}
        onAddColumn={onAddColumn}
        onRenameColumn={onRenameColumn}
        onDeleteColumn={onDeleteColumn}
        onImport={onImport}
        templateFilename="metadata_template.csv"
        templateKeyHeader="filename"
        hint={t("Sample ID (sample_id) is editable and saved with the workspace. It defaults to the filename; filenames are read-only. Import CSV/TSV using filename as the first column and sample_id plus any condition fields after it. Metadata drives Plotting groups, replicate units and facets.")}
        emptyMessage={t("Load one or more FCS files to add sample metadata.")}
      />

      <EditableMetaTable
        title={t("Population metadata")}
        rowHeader={t("Population")}
        fixedHeaders={[t("Parent"), t("Count"), t("% Parent")]}
        rows={populationRows}
        columns={populationColumns}
        values={populationMetadata}
        onSetCell={onSetPopCell}
        onAddColumn={onAddPopColumn}
        onRenameColumn={onRenamePopColumn}
        onDeleteColumn={onDeletePopColumn}
        templateFilename="population_metadata_template.csv"
        templateKeyHeader="population"
        hint={t("Annotate each gated population (e.g. lineage, class, note). Values are keyed to the population, so they persist through renames. Derived Parent / Count / % Parent are read-only.")}
        emptyMessage={t("Draw a gate to create populations, then annotate them here.")}
      />
    </div>
  );
}
