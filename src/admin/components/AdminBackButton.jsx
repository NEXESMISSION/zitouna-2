import { useNavigate } from 'react-router-dom'

export default function AdminBackButton() {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate(-1)}
      className="zitu-page__btn"
      style={{ marginBottom: 8 }}
    >
      ← Back
    </button>
  )
}

