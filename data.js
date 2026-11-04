// ================= CONFIG & INITIAL DATA =================
const SUPABASE_CONFIG = {
  url: "https://kismrqmcvzdavbxueghc.supabase.co",
  key: "sb_publishable_GrL_AiIKbiBUnm9yiNKczA_hV_vmc_B",
  bucket: "materials"
};

// Default subjects if cloud storage is empty on first boot
const DEFAULT_SUBJECTS = [
  { id: "subj_applied_dev", name: "Разработка прикладных приложений", createdAt: "2026-11-03T12:00:00.000Z", subfolders: [] },
  { id: "subj_english", name: "Английский язык", createdAt: "2026-11-03T12:00:00.000Z", subfolders: [] },
  { id: "subj_multimedia", name: "Мультимедийная техника", createdAt: "2026-11-03T12:00:00.000Z", subfolders: [] }
];
