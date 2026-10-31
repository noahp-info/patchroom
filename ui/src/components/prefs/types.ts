/** A DM the prefs lists can name. The workspace passes its sessions in. */
export interface PrefsDm {
  id: string;
  name: string;
}

/** A sidebar section the prefs lists can name: a folder section carries its home folder. */
export interface PrefsSection {
  id: string;
  name: string;
  folder?: string | null;
}
