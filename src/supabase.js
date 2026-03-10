import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL || "https://gvxdmldpimjvicllrhll.supabase.co";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eGRtbGRwaW1qdmljbGxyaGxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MTE2OTUsImV4cCI6MjA4Nzk4NzY5NX0.6EnrECgVy79VUNsbRQGL_shmhaWnPAq0BL2uYz6ilF0";

export const supabase = createClient(url, key);
