import { createFileRoute } from '@tanstack/react-router'
import { Scripts } from '../ui/pages/Scripts'

export const Route = createFileRoute('/scripts')({ component: Scripts })
