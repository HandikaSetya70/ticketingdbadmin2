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
    const { ticket_id, user_id } = req.body

    // Validate required fields
    if (!ticket_id || !user_id) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: ticket_id, user_id'
      })
    }

    // Check if ticket exists and belongs to the user
    const { data: ticket, error: ticketError } = await supabase
      .from('tickets')
      .select(`
        *,
        events (
          event_name,
          event_date,
          venue
        )
      `)
      .eq('ticket_id', ticket_id)
      .single()

    if (ticketError || !ticket) {
      return res.status(404).json({
        status: 'error',
        message: 'Ticket not found'
      })
    }

    // Check if ticket belongs to the user
    if (ticket.user_id !== user_id) {
      return res.status(403).json({
        status: 'error',
        message: 'Ticket does not belong to this user'
      })
    }

    // Check ticket status
    if (ticket.ticket_status === 'revoked') {
      return res.status(403).json({
        status: 'error',
        message: 'Ticket has been revoked',
        data: {
          ticket_id: ticket.ticket_id,
          status: ticket.ticket_status
        }
      })
    }

    // If ticket is part of a group, get group status
    let groupStatus = null
    if (ticket.is_parent_ticket || ticket.parent_ticket_id) {
      const parentId = ticket.is_parent_ticket ? ticket.ticket_id : ticket.parent_ticket_id
      
      const { data: groupTickets, error: groupError } = await supabase
        .from('tickets')
        .select('ticket_status')
        .or(`ticket_id.eq.${parentId},parent_ticket_id.eq.${parentId}`)

      if (!groupError && groupTickets) {
        groupStatus = {
          total_tickets: groupTickets.length,
          valid_tickets: groupTickets.filter(t => t.ticket_status === 'valid').length,
          revoked_tickets: groupTickets.filter(t => t.ticket_status === 'revoked').length
        }
      }
    }

    return res.status(200).json({
      status: 'success',
      message: 'Ticket is valid',
      data: {
        ticket_id: ticket.ticket_id,
        blockchain_ticket_id: ticket.blockchain_ticket_id,
        event_name: ticket.events?.event_name,
        event_date: ticket.events?.event_date,
        venue: ticket.events?.venue,
        status: ticket.ticket_status,
        qr_code_hash: ticket.qr_code_hash,
        ticket_number: ticket.ticket_number,
        total_tickets_in_group: ticket.total_tickets_in_group,
        group_status: groupStatus
      }
    })

  } catch (error) {
    console.error('Error validating ticket:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while validating the ticket',
      error: error.message
    })
  }
}