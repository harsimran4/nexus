import { createFileRoute } from '@tanstack/react-router'
import { Archive } from '../ui/pages/Archive'

export const Route = createFileRoute('/archive')({ component: Archive })
