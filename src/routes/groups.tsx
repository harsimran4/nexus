import { createFileRoute } from '@tanstack/react-router'
import { Groups } from '../ui/pages/Groups'

export const Route = createFileRoute('/groups')({ component: Groups })
