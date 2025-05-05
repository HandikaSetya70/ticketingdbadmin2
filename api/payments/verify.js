import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Method not allowed' 
    })
  }

  try {
    // Get the authorization header
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        status: 'error',
        message: 'Missing or invalid authorization header'
      })
    }

    const token = authHeader.split(' ')[1]
    
    // Verify the admin token and get user details
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid or expired token'
      })
    }

    // Check if the user has admin role
    const { data: adminUser, error: adminError } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', user.id)
      .single()

    if (adminError || !adminUser || !['admin', 'super_admin'].includes(adminUser.role)) {
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized. Admin access required.'
      })
    }

    // Get the request data
    const { payment_id, status } = req.body

    // Validate required fields
    if (!payment_id || !status) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: payment_id, status'
      })
    }

    // Validate status value
    if (!['confirmed', 'failed'].includes(status)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Must be "confirmed" or "failed"'
      })
    }

    // Check if payment exists
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('*')
      .eq('payment_id', payment_id)
      .single()

    if (paymentError || !payment) {
      return res.status(404).json({
        status: 'error',
        message: 'Payment not found'
      })
    }

    // Update payment status
    const { data: updatedPayment, error: updateError } = await supabase
      .from('payments')
      .update({ payment_status: status })
      .eq('payment_id', payment_id)
      .select()
      .single()

    if (updateError) {
      throw updateError
    }

    return res.status(200).json({
      status: 'success',
      message: `Payment ${status} successfully`,
      data: updatedPayment
    })

  } catch (error) {
    console.error('Error verifying payment:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while verifying the payment',
      error: error.message
    })
  }
}