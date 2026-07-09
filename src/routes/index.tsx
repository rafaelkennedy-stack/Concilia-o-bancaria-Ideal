import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { Landmark, Sparkles, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { user, loading } = useAuth();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5" />
            <span className="font-semibold">Financeiro</span>
          </div>
          <nav className="flex gap-2">
            {loading ? null : user ? (
              <Button asChild><Link to="/conciliacao">Abrir conciliação</Link></Button>
            ) : (
              <Button asChild><Link to="/auth">Entrar</Link></Button>
            )}
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-20">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Conciliação Bancária com IA</h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Envie o extrato do BB (Excel) e o extrato do Agrotis (PDF). A IA identifica os lançamentos, sugere os casamentos e você confirma em segundos.
          </p>
          <div className="mt-8 flex gap-3">
            {user ? (
              <Button asChild size="lg"><Link to="/conciliacao">Ir para conciliações</Link></Button>
            ) : (
              <Button asChild size="lg"><Link to="/auth">Entrar</Link></Button>
            )}
          </div>
        </div>
        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          <Feature icon={<Sparkles className="h-5 w-5" />} title="Sugestões automáticas" desc="Casamentos por valor, data, tipo e beneficiário." />
          <Feature icon={<ShieldCheck className="h-5 w-5" />} title="Auditoria completa" desc="Log de quem processou, confirmou e reabriu." />
          <Feature icon={<Landmark className="h-5 w-5" />} title="Perfis distintos" desc="Dani opera, Diretor reabre conciliações fechadas." />
        </div>
      </main>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-lg border p-6">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent">{icon}</div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}
