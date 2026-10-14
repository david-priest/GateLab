// imagingPresets.ts — biplots worth drawing on a FACSDiscover S8 file, named by what they show,
// from the per-event image features Chorus writes. BD's own doublet plot is Eccentricity against
// Radial Moment on the LightLoss image; its mitotic-stage gating used Max Intensity, Radial Moment
// and Eccentricity; Correlation and Delta CoM read co-localisation and translocation between two
// channels (BD FACSDiscover S8 job aids and Schraivogel et al. 2022). A preset exists only when
// the file carries both of its channels, so this is a lookup over the channel labels, no data.

export interface ImagingPreset {
  readonly id: string;
  /** What the plot shows, in a few words: a sentence for t(), with {channel} or {pair} filled from `vars`. */
  readonly title: string;
  /** Why these two channels, for the tooltip; the same placeholders. */
  readonly note: string;
  readonly vars: Readonly<Record<string, string>>;
  /** Channel indices in the sample's channel list. */
  readonly x: number;
  readonly y: number;
}

/** "Feature (Channel)" → [feature, channel]; null for any other label. */
export function splitImagingFeature(label: string): [string, string] | null {
  const m = /^(Size|Max Intensity|Long Axis Moment|Short Axis Moment|Radial Moment|Total Intensity|Eccentricity|Diffusivity|Delta CoM|Correlation) \((.+)\)$/i.exec(label.trim());
  return m ? [m[1], m[2]] : null;
}

const SCATTER_ORDER = [/^LightLoss/i, /^FSC/i, /^SSC/i];

/** The presets a file supports, from its channel labels in order. */
export function imagingPlotPresets(labels: readonly string[]): ImagingPreset[] {
  const byFeature = new Map<string, Map<string, number>>();
  labels.forEach((label, i) => {
    const split = splitImagingFeature(label);
    if (!split) return;
    const [feature, channel] = split;
    const key = feature.toLowerCase();
    if (!byFeature.has(key)) byFeature.set(key, new Map());
    byFeature.get(key)!.set(channel, i);
  });
  const at = (feature: string, channel: string): number | undefined => byFeature.get(feature.toLowerCase())?.get(channel);
  const channelsOf = (feature: string): string[] => [...(byFeature.get(feature.toLowerCase())?.keys() ?? [])];
  const scatterFirst = (channels: string[]): string[] =>
    channels.slice().sort((a, b) => {
      const ra = SCATTER_ORDER.findIndex((re) => re.test(a));
      const rb = SCATTER_ORDER.findIndex((re) => re.test(b));
      return (ra < 0 ? 9 : ra) - (rb < 0 ? 9 : rb);
    });
  const out: ImagingPreset[] = [];

  // Doublets: BD's own plot, on the first scatter image that has both features.
  for (const channel of scatterFirst(channelsOf("Radial Moment"))) {
    const x = at("Radial Moment", channel);
    const y = at("Eccentricity", channel);
    if (x === undefined || y === undefined || !SCATTER_ORDER.some((re) => re.test(channel))) continue;
    out.push({ id: "doublets", title: "Doublets", note: "BD's doublet plot: two cells in one image are long (Eccentricity) and spread (Radial Moment), on the {channel} image", vars: { channel }, x, y });
    break;
  }
  // Size and shape, on the first scatter image with both.
  for (const channel of scatterFirst(channelsOf("Size"))) {
    const x = at("Size", channel);
    const y = at("Eccentricity", channel);
    if (x === undefined || y === undefined || !SCATTER_ORDER.some((re) => re.test(channel))) continue;
    out.push({ id: "size-shape", title: "Size and shape", note: "Mask area against elongation on the {channel} image; debris is small, doublets and mitotic cells are long", vars: { channel }, x, y });
    break;
  }
  // Punctate against diffuse, per fluorescence image (not the scatter images).
  for (const channel of channelsOf("Diffusivity")) {
    if (SCATTER_ORDER.some((re) => re.test(channel))) continue;
    const x = at("Max Intensity", channel);
    const y = at("Diffusivity", channel);
    if (x === undefined || y === undefined) continue;
    out.push({ id: `spread:${channel}`, title: "Punctate or diffuse · {channel}", note: "Diffusivity is the stained area over the peak intensity: low for spots, high for a stain spread over the cell", vars: { channel }, x, y });
  }
  // Co-localisation and translocation, per channel pair with both features.
  for (const pair of channelsOf("Correlation")) {
    const x = at("Correlation", pair);
    const y = at("Delta CoM", pair);
    if (x === undefined || y === undefined) continue;
    out.push({ id: `coloc:${pair}`, title: "Co-localisation · {pair}", note: "Correlation of the two images pixel by pixel against the distance between their centres of mass: co-localised stains sit high and left, a translocation moves right", vars: { pair }, x, y });
  }
  return out;
}
