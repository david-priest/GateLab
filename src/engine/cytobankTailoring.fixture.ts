// A Cytobank Gating-ML file with one gate, and that gate as Cytobank tailored it for D2.fcs.
// Synthetic names. Shared by the engine and App tests.

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const gate = (gid: string, fileName: string, max: number) => `
  <gating:RectangleGate gating:id="${gid}">
    <data-type:custom_info><cytobank><name>CD4_positive</name><id>1</id><gate_id>1</gate_id><type>RectangleGate</type>
      <version>-1</version><compensation_id>-2</compensation_id>
      <fcs_file_id>${fileName ? "101" : ""}</fcs_file_id><tailored>true</tailored>
      <fcs_file_filename>${fileName}</fcs_file_filename>
    </cytobank></data-type:custom_info>
    <gating:dimension gating:compensation-ref="uncompensated" gating:min="0" gating:max="${max}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:compensation-ref="uncompensated" gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  </gating:RectangleGate>`;
export const CYTOBANK_TAILORED = `<?xml version="1.0"?><gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}">
  <data-type:custom_info><cytobank><experiment_number>000000</experiment_number></cytobank></data-type:custom_info>
  ${gate("Gate_1_base", "", 500)}${gate("Gate_1_D2", "D2.fcs", 900)}</gating:Gating-ML>`;
