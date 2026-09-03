import { APP_NAME } from '@earth/ui'

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center px-5">
        <h1 className="text-lg font-semibold tracking-tight">{APP_NAME}</h1>
      </header>
    </main>
  )
}
