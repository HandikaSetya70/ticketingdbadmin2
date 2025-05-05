import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'http://setya.fwh.is'); // Use '*' during testing, later restrict to your domain
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
    const { user_id, event_id, payment_id, quantity = 1 } = req.body

    // Validate required fields
    if (!user_id || !payment_id) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: user_id, payment_id'
      })
    }

    // Verify payment is confirmed
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('payment_status')
      .eq('payment_id', payment_id)
      .single()

    if (paymentError || !payment) {
      return res.status(404).json({
        status: 'error',
        message: 'Payment not found'
      })
    }

    if (payment.payment_status !== 'confirmed') {
      return res.status(400).json({
        status: 'error',
        message: 'Payment is not confirmed'
      })
    }

    // Create tickets
    const tickets = []
    let parentTicketId = null
    
    for (let i = 1; i <= quantity; i++) {
      const ticketData = {
        user_id,
        event_id,
        payment_id,
        is_parent_ticket: i === 1,
        parent_ticket_id: i === 1 ? null : parentTicketId,
        ticket_number: i,
        total_tickets_in_group: quantity,
        blockchain_ticket_id: `BLOCKCHAIN-${payment_id}-${i}`,
        qr_code_hash: `QR-${payment_id}-${i}-${Date.now()}`,
        ticket_status: 'valid'
      }
      
      const { data: ticket, error: ticketError } = await supabase
        .from('tickets')
        .insert(ticketData)
        .select()
        .single()
      
      if (ticketError) {
        throw ticketError
      }
      
      // Store parent ticket ID for subsequent tickets
      if (i === 1) {
        parentTicketId = ticket.ticket_id
      }
      
      tickets.push(ticket)
    }

    return res.status(201).json({
      status: 'success',
      message: `Created ${quantity} ticket(s) successfully`,
      data: {
        tickets
      }
    })

  } catch (error) {
    console.error('Error creating tickets:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while creating tickets',
      error: error.message
    })
  }
}