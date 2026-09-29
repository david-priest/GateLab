# Gating-ML 2.0 XML schema (ISAC), test-only

These three files are the ISAC Gating-ML 2.0 XML Schema, schema version 2.0.121207, unmodified. `gatingmlSchema.test.ts` validates GateLab's Gating-ML exports against them with `xmllint`. Nothing in the application imports them, and they are not part of the production bundle.

Source: copied byte for byte from the `flowkit/_resources` directory of FlowKit 1.3.1 (https://github.com/whitews/flowkit), which distributes the ISAC files for the same purpose. The schema is published by ISAC at http://flowcyt.sourceforge.net/gating/2.0/xsd/.

| File | SHA-256 |
|---|---|
| `Gating-ML.v2.0.xsd` | `8ef0c6a6e0af778b402373a9acf2f07f0092f5acde6d4992b163d0cbdced7576` |
| `Transformations.v2.0.xsd` | `1ad9f153c92d8d16e74db547cf05e0ff1170e6efa4b4e5559addf703712f8db7` |
| `DataTypes.v2.0.xsd` | `c32031e8a739d0a79f3843a7efc5719631bb11de020f5a13948896f8fdc2087d` |

## Licence

Each file carries ISAC's notice: "Copyright (c) 2008-2014 ISAC (International Society for Advancement of Cytometry). Free of charge distribution and read-only usage permited. Modification and all other rights reserved. For all other uses please contact ISAC."

They are therefore redistributed here free of charge and unmodified, and used read-only. Do not edit them, reformat them, or strip their annotations; a change of any kind is a modification the licence does not grant. To update them, replace them with a newer ISAC release and update the hashes above.
