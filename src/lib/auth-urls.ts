// URL para onde o link de recuperação de senha aponta.
//
// Precisa ser ABSOLUTA e estar na allowlist de "Redirect URLs" do Supabase — o
// Supabase recusa o redirect e joga o usuário na Site URL se a URL não estiver lá.
//
// Fixada na produção porque é o único destino cadastrado no Supabase. Consequência
// prática: mesmo pedindo a recuperação em localhost, o email leva para produção.
// Para testar o fluxo localmente, cadastre também
// http://localhost:8080/auth/update-password nas Redirect URLs do Supabase e use
// VITE_PASSWORD_RESET_REDIRECT no .env.local.
const PRODUCAO = "https://concilia-o-bancaria-ideal.vercel.app/auth/update-password";

export const PASSWORD_RESET_REDIRECT =
  import.meta.env.VITE_PASSWORD_RESET_REDIRECT || PRODUCAO;
