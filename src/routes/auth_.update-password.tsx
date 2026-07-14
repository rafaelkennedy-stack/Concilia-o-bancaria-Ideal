import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { TriangleAlert } from "lucide-react";

// Rota "auth_" (com underscore) = NÃO aninha dentro de auth.tsx.
// URL final: /auth/update-password — é ela que vai na allowlist do Supabase.
export const Route = createFileRoute("/auth_/update-password")({
  component: UpdatePassword,
});

const MIN_SENHA = 6;

type Estado = "verificando" | "pronto" | "invalido";

function UpdatePassword() {
  const navigate = useNavigate();
  const [estado, setEstado] = useState<Estado>("verificando");
  const [erroLink, setErroLink] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Link expirado ou já usado: o Supabase devolve o erro na própria URL (na hash,
    // no fluxo implícito; na query, no PKCE).
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const erro = hash.get("error_description") ?? query.get("error_description");
    if (erro) {
      setErroLink(erro.replace(/\+/g, " "));
      setEstado("invalido");
      return;
    }

    // O cliente Supabase processa o token da URL sozinho (detectSessionInUrl) ao
    // ser criado — o que acontece no AuthProvider, ANTES desta tela montar. Ou seja,
    // o evento PASSWORD_RECOVERY pode já ter passado. Por isso não dependemos só do
    // listener: consultamos a sessão também, e vale o que chegar primeiro.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) setEstado("pronto");
    });

    supabase.auth.getSession().then(({ data }) => {
      // getSession() só resolve depois que a URL foi processada, então a ausência de
      // sessão aqui significa mesmo link inválido — e não uma corrida.
      setEstado((atual) => (atual !== "verificando" ? atual : data.session ? "pronto" : "invalido"));
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < MIN_SENHA) {
      toast.error(`A senha precisa ter ao menos ${MIN_SENHA} caracteres.`);
      return;
    }
    if (pw !== pw2) {
      toast.error("As senhas não conferem.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) {
      toast.error("Não foi possível salvar a senha", { description: error.message });
      return;
    }
    toast.success("Senha alterada. Você já está conectado.");
    navigate({ to: "/conciliacao" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Definir nova senha</CardTitle>
          <CardDescription>
            {estado === "pronto" ? "Escolha uma nova senha para sua conta." : "Verificando o link…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {estado === "verificando" && (
            <p className="py-4 text-sm text-muted-foreground">Validando o link de recuperação…</p>
          )}

          {estado === "invalido" && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <div className="font-medium">Link inválido ou expirado</div>
                  <p className="mt-1">
                    {erroLink ?? "Abra esta página pelo link enviado no email de recuperação."}
                    {" "}Peça um novo link para tentar de novo.
                  </p>
                </div>
              </div>
              <Button asChild className="w-full">
                <Link to="/auth/reset-password">Pedir novo link</Link>
              </Button>
            </div>
          )}

          {estado === "pronto" && (
            <form className="space-y-3" onSubmit={submit}>
              <div>
                <Label htmlFor="pw">Nova senha</Label>
                <Input
                  id="pw" type="password" value={pw} required minLength={MIN_SENHA}
                  autoComplete="new-password" onChange={(e) => setPw(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pw2">Confirmar nova senha</Label>
                <Input
                  id="pw2" type="password" value={pw2} required minLength={MIN_SENHA}
                  autoComplete="new-password" onChange={(e) => setPw2(e.target.value)}
                />
                {pw2.length > 0 && pw !== pw2 && (
                  <p className="mt-1 text-xs text-rose-600">As senhas não conferem.</p>
                )}
              </div>
              <Button type="submit" className="w-full" disabled={busy || !pw || pw !== pw2}>
                {busy ? "Salvando…" : "Salvar nova senha"}
              </Button>
            </form>
          )}

          <p className="mt-4 text-center text-xs text-muted-foreground">
            <Link to="/auth" className="hover:underline">← voltar para o login</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
