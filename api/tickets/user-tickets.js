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

  // Only allow GET requests
  if (req.method !== 'GET') {
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
    
    // Verify the token and get user details
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid or expired token'
      })
    }

    // Get the authenticated user's profile
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .select('user_id, role')
      .eq('auth_id', user.id)
      .single()

    if (profileError || !userProfile) {
      return res.status(404).json({
        status: 'error',
        message: 'User profile not found'
      })
    }

    // Get user_id from query parameters or use authenticated user's ID
    const { user_id, status, event_id, group_by_event } = req.query
    let targetUserId = user_id || userProfile.user_id

    // Check if user is requesting their own tickets or is an admin
    if (targetUserId !== userProfile.user_id && 
        !['admin', 'super_admin'].includes(userProfile.role)) {
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized access to other user\'s tickets'
      })
    }

    // Build the query
    let query = supabase
      .from('tickets')
      .select(`
        *,
        events (
          event_id,
          event_name,
          event_date,
          venue
        ),
        payments (
          payment_id,
          amount,
          payment_status
        )
      `)
      .eq('user_id', targetUserId)
      .order('purchase_date', { ascending: false })

    // Apply filters
    if (status) {
      query = query.eq('ticket_status', status)
    }
    if (event_id) {
      query = query.eq('event_id', event_id)
    }

    // Execute query
    const { data: tickets, error: ticketsError } = await query

    if (ticketsError) {
      throw ticketsError
    }

    // Group tickets by event if requested
    if (group_by_event === 'true') {
      const groupedTickets = tickets.reduce((acc, ticket) => {
        const eventId = ticket.event_id || 'no_event'
        if (!acc[eventId]) {
          acc[eventId] = {
            event: ticket.events,
            tickets: []
          }
        }
        acc[eventId].tickets.push(ticket)
        return acc
      }, {})

      return res.status(200).json({
        status: 'success',
        message: 'User tickets retrieved successfully',
        data: {
          total_tickets: tickets.length,
          grouped_tickets: groupedTickets
        }
      })
    }

    // Group tickets by parent/child relationship
    const parentTickets = tickets.filter(t => t.is_parent_ticket)
    const ticketGroups = parentTickets.map(parent => {
      const children = tickets.filter(t => t.parent_ticket_id === parent.ticket_id)
      return {
        parent: parent,
        children: children,
        total_in_group: parent.total_tickets_in_group
      }
    })

    // Add standalone tickets (no parent/child relationship)
    const standaloneTickets = tickets.filter(t => !t.is_parent_ticket && !t.parent_ticket_id)

    return res.status(200).json({
      status: 'success',
      message: 'User tickets retrieved successfully',
      data: {
        total_tickets: tickets.length,
        ticket_groups: ticketGroups,
        standalone_tickets: standaloneTickets,
        summary: {
          total: tickets.length,
          valid: tickets.filter(t => t.ticket_status === 'valid').length,
          revoked: tickets.filter(t => t.ticket_status === 'revoked').length,
          events_count: [...new Set(tickets.map(t => t.event_id))].length
        }
      }
    })

  } catch (error) {
    console.error('Error fetching user tickets:', error)
    return res.status(500).json({
      status: 'error',
      message: 'An error occurred while fetching user tickets',
      error: error.message
    })
  }
}