import { createFileRoute } from '@tanstack/react-router'
import { Admin } from '../ui/pages/Admin'

export const Route = createFileRoute('/admin')({ component: Admin })
