// MetadataTab.tsx — two editable metadata tables (hand-rolled, no table library):
//  • Sample metadata: rows = loaded samples; derived Events/Ch/Instr + user fields. These drive the
//    Proportions tab's Group / Unit / Facet. Imported from CSV/TSV joined on FCS filename.
//  • Population metadata: rows = gated populations; derived Parent / Count / % Parent + user fields
//    (annotation — lineage, class, note…). Keyed by population id, so it survives renames.
// Both tables share <EditableMetaTable>. GateLab's colData-free stand-in.

import type { Sample } from "../engine/sample";
import type { MetadataColumn } from "../engine/metadata";
import { EditableMetaTable, type MetaRow } from "./EditableMetaTable";

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
}

export function MetadataTab({
  samples, metadata, columns, onSetCell, onAddColumn, onRenameColumn, onDeleteColumn, onImport,
  populationRows, populationMetadata, populationColumns, onSetPopCell, onAddPopColumn, onRenamePopColumn, onDeletePopColumn,
}: Props) {
  const sampleRows: MetaRow[] = samples.map((s) => ({
    id: s.id,
    name: s.name,
    fixed: [s.sample.fcs.nEvents.toLocaleString(), s.sample.channels.length, s.sample.instrument],
  }));

  return (
    <div className="gl-tab-panel">
      <EditableMetaTable
        title="Sample metadata"
        rowHeader="Sample"
        fixedHeaders={["Events", "Ch", "Instr."]}
        rows={sampleRows}
        columns={columns}
        values={metadata}
        onSetCell={onSetCell}
        onAddColumn={onAddColumn}
        onRenameColumn={onRenameColumn}
        onDeleteColumn={onDeleteColumn}
        onImport={onImport}
        templateFilename="metadata_template.csv"
        templateKeyHeader="filename"
        hint="First column of an imported CSV/TSV must be the FCS file name; remaining columns become fields (joined by filename, extension-insensitive). Edit any cell inline. These fields drive the Proportions tab's Group / Unit / Facet."
        emptyMessage="Load one or more FCS files to add sample metadata."
      />

      <EditableMetaTable
        title="Population metadata"
        rowHeader="Population"
        fixedHeaders={["Parent", "Count", "% Parent"]}
        rows={populationRows}
        columns={populationColumns}
        values={populationMetadata}
        onSetCell={onSetPopCell}
        onAddColumn={onAddPopColumn}
        onRenameColumn={onRenamePopColumn}
        onDeleteColumn={onDeletePopColumn}
        templateFilename="population_metadata_template.csv"
        templateKeyHeader="population"
        hint="Annotate each gated population (e.g. lineage, class, note). Values are keyed to the population, so they persist through renames. Derived Parent / Count / % Parent are read-only."
        emptyMessage="Draw a gate to create populations, then annotate them here."
      />
    </div>
  );
}
