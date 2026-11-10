import { AppProviders } from './app/providers'
import { AppRouter } from './app/router'
import './App.css'

function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  )
}

export default App
