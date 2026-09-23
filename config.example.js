/* Copy this file to config.js and fill in your own project's values.
   config.js is gitignored, so your keys never reach the public repo.

   Both values come from the Supabase dashboard:
     Project Settings → API → Project URL, and the "anon / public" key.

   The anon key is designed to be public — it identifies the project, it does
   not grant access. Access is decided by Row Level Security in schema.sql,
   which limits reads and writes to the emails listed in trip_members.
   Never put the "service_role" key here; that one does bypass RLS. */

window.TRIP_CONFIG = {
  supabaseUrl:     'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY',

  // Other free OpenFreeMap styles: bright, liberty, dark, fiord.
  // "positron" is the muted one that suits the paper palette.
  mapStyle: 'https://tiles.openfreemap.org/styles/positron'
};
