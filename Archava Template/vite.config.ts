import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import { avatarkitVitePlugin } from "@spatius/avatarkit/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), avatarkitVitePlugin()],
    server: {
      port: 5174,
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${env.PORT || 5002}` },
    },
  };
});
