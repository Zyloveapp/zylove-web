import VisibilityControl from '../components/profile/VisibilityControl'
import ZyloveScore from '../components/profile/ZyloveScore'

// Stub profile page: account controls only until the profile view is built.
export default function Profile() {
  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-gray-950 px-4 py-6 text-white lg:min-h-[calc(100dvh-3.5rem)]">
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="text-2xl font-bold">Profile</h1>
        <ZyloveScore />
        <VisibilityControl />
      </div>
    </div>
  )
}
