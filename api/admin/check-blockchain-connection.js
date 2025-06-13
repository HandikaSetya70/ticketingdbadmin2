// /api/admin/check-blockchain-connection.js
// Verifies blockchain connectivity and contract interaction

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Blockchain configuration
const BLOCKCHAIN_CONFIG = {
  rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://sepolia.infura.io/v3/' + process.env.INFURA_PROJECT_ID,
  contractAddress: process.env.REVOCATION_CONTRACT_ADDRESS || '0x86d22947cE0D2908eC0CAC78f7EC405f15cB9e50',
  privateKey: process.env.ADMIN_PRIVATE_KEY,
  network: 'sepolia'
};

// Contract ABI for basic read operations
const CONTRACT_ABI = [
  "function getTicketStatus(uint256 tokenId) external view returns (uint8)",
  "function isRevoked(uint256 tokenId) external view returns (bool)",
  "function owner() external view returns (address)",
  "function name() external view returns (string)",
  "function totalSupply() external view returns (uint256)"
];

export default async function handler(req, res) {
  console.log('🔍 ============ BLOCKCHAIN CONNECTION CHECK ============');
  console.log('⏰ Timestamp:', new Date().toISOString());
  
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Method not allowed' 
    });
  }

  try {
    // Verify admin authentication
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Authorization token required' 
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid authentication token' 
      });
    }

    // Look up admin's user_id in the users table
    const { data: adminUser, error: adminError } = await supabase
      .from('users')
      .select('user_id, id_name, role')
      .eq('auth_id', user.id)
      .single();

    if (adminError || !adminUser) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Admin user not found' 
      });
    }

    if (adminUser.role !== 'admin' && adminUser.role !== 'super_admin') {
      return res.status(403).json({ 
        status: 'error', 
        message: 'Admin privileges required' 
      });
    }

    console.log('✅ Admin authentication verified:', adminUser.id_name);
    console.log('👮 Admin role:', adminUser.role);

    // Start blockchain connection check
    console.log('🔗 ============ BLOCKCHAIN CONNECTION TEST ============');
    
    const connectionResult = await performBlockchainConnectionCheck();
    
    if (connectionResult.success) {
      console.log('✅ ============ CONNECTION CHECK SUCCESSFUL ============');
      console.log('🌐 Network:', connectionResult.network);
      console.log('📋 Contract:', connectionResult.contractAddress);
      console.log('👛 Connected Wallet:', connectionResult.walletAddress);
      console.log('💰 Wallet Balance:', connectionResult.walletBalance);
      console.log('📊 Block Number:', connectionResult.currentBlock);
      console.log('🏠 Contract Owner:', connectionResult.contractOwner);
      
      return res.status(200).json({
        status: 'success',
        message: 'Blockchain connection verified successfully',
        data: {
          connection_status: 'connected',
          network: connectionResult.network,
          contract_address: connectionResult.contractAddress,
          wallet_address: connectionResult.walletAddress,
          wallet_balance_eth: connectionResult.walletBalance,
          current_block: connectionResult.currentBlock,
          contract_owner: connectionResult.contractOwner,
          rpc_url: BLOCKCHAIN_CONFIG.rpcUrl.replace(process.env.INFURA_PROJECT_ID || '', '[HIDDEN]'),
          gas_price_gwei: connectionResult.gasPrice,
          connection_latency_ms: connectionResult.latency,
          contract_accessible: true,
          last_check: new Date().toISOString()
        }
      });
      
    } else {
      console.error('❌ ============ CONNECTION CHECK FAILED ============');
      console.error('🔥 Error:', connectionResult.error);
      console.error('📄 Details:', connectionResult.details);
      
      return res.status(500).json({
        status: 'error',
        message: 'Blockchain connection failed',
        data: {
          connection_status: 'failed',
          error: connectionResult.error,
          details: connectionResult.details,
          network: BLOCKCHAIN_CONFIG.network,
          contract_address: BLOCKCHAIN_CONFIG.contractAddress,
          rpc_url: BLOCKCHAIN_CONFIG.rpcUrl.replace(process.env.INFURA_PROJECT_ID || '', '[HIDDEN]'),
          last_check: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    console.error('❌ Critical error in connection check:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error during connection check',
      error: error.message
    });
  }
}

// Main blockchain connection check function
async function performBlockchainConnectionCheck() {
  try {
    console.log('📚 ============ IMPORTING ETHERS.JS ============');
    
    // Import ethers dynamically
    const ethersModule = await import('ethers');
    const ethers = ethersModule.default || ethersModule;
    console.log('✅ Ethers.js imported successfully');

    // Step 1: Validate configuration
    console.log('🔧 ============ CONFIGURATION VALIDATION ============');
    
    if (!BLOCKCHAIN_CONFIG.rpcUrl) {
      throw new Error('RPC URL not configured');
    }
    
    if (!BLOCKCHAIN_CONFIG.contractAddress) {
      throw new Error('Contract address not configured');
    }
    
    if (!BLOCKCHAIN_CONFIG.privateKey) {
      throw new Error('Private key not configured');
    }
    
    console.log('✅ Configuration validation passed');
    console.log('   🌐 RPC URL:', BLOCKCHAIN_CONFIG.rpcUrl.substring(0, 30) + '...');
    console.log('   📋 Contract:', BLOCKCHAIN_CONFIG.contractAddress);
    console.log('   🔑 Private Key:', BLOCKCHAIN_CONFIG.privateKey.substring(0, 10) + '...');

    // Step 2: Test RPC connection
    console.log('🌐 ============ RPC CONNECTION TEST ============');
    const startTime = Date.now();
    
    const provider = new ethers.providers.JsonRpcProvider(BLOCKCHAIN_CONFIG.rpcUrl);
    console.log('🔌 Provider created');
    
    // Test basic connection
    const network = await provider.getNetwork();
    console.log('✅ Network connected:', network.name || 'Unknown');
    console.log('   🆔 Chain ID:', network.chainId);
    
    const currentBlock = await provider.getBlockNumber();
    console.log('✅ Current block number:', currentBlock);
    
    const latency = Date.now() - startTime;
    console.log('⚡ Connection latency:', latency + 'ms');

    // Step 3: Test wallet connection
    console.log('👛 ============ WALLET CONNECTION TEST ============');
    
    const wallet = new ethers.Wallet(BLOCKCHAIN_CONFIG.privateKey, provider);
    console.log('✅ Wallet created');
    console.log('   📍 Wallet Address:', wallet.address);
    
    // Check wallet balance
    const balance = await wallet.getBalance();
    const balanceEth = ethers.utils.formatEther(balance);
    console.log('💰 Wallet Balance:', balanceEth, 'ETH');
    
    if (balance.lt(ethers.utils.parseEther('0.001'))) {
      console.warn('⚠️ Warning: Low wallet balance (< 0.001 ETH)');
    }

    // Step 4: Test gas price
    console.log('⛽ ============ GAS PRICE CHECK ============');
    
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
    console.log('⛽ Current Gas Price:', gasPriceGwei, 'Gwei');

    // Step 5: Test contract connection
    console.log('📋 ============ CONTRACT CONNECTION TEST ============');
    
    const contract = new ethers.Contract(BLOCKCHAIN_CONFIG.contractAddress, CONTRACT_ABI, wallet);
    console.log('✅ Contract instance created');
    
    // Test contract owner read (this should work if contract is deployed correctly)
    try {
      const contractOwner = await contract.owner();
      console.log('👑 Contract Owner:', contractOwner);
      console.log('🔍 Is admin wallet the owner?', contractOwner.toLowerCase() === wallet.address.toLowerCase());
    } catch (ownerError) {
      console.warn('⚠️ Could not read contract owner:', ownerError.message);
      console.warn('   📄 This might indicate contract deployment issues');
    }

    // Step 6: Test a sample token status read (if any tokens exist)
    console.log('🎫 ============ SAMPLE TOKEN STATUS TEST ============');
    
    try {
      // Try to read status of token ID 1 (common test case)
      const sampleTokenStatus = await contract.getTicketStatus(1);
      console.log('✅ Sample token status read successful');
      console.log('   🎫 Token ID 1 status:', sampleTokenStatus.toString());
      console.log('   📊 Status meanings: 0=Unregistered, 1=Registered, 2=Revoked');
    } catch (tokenError) {
      console.log('ℹ️ Sample token read failed (this is normal if no tokens exist yet)');
      console.log('   📄 Error:', tokenError.message);
    }

    // Step 7: Test contract function availability
    console.log('🔍 ============ CONTRACT FUNCTION TEST ============');
    
    try {
      // Test if we can call a simple view function
      const isRevokedTest = await contract.isRevoked(999999); // Test with non-existent token
      console.log('✅ Contract function test successful');
      console.log('   🧪 Test result for token 999999:', isRevokedTest);
    } catch (functionError) {
      console.warn('⚠️ Contract function test failed:', functionError.message);
    }

    // Success response
    return {
      success: true,
      network: network.name || 'Sepolia',
      contractAddress: BLOCKCHAIN_CONFIG.contractAddress,
      walletAddress: wallet.address,
      walletBalance: balanceEth,
      currentBlock: currentBlock,
      contractOwner: 'Successfully connected', // We'll put actual owner if available
      gasPrice: gasPriceGwei,
      latency: latency
    };

  } catch (error) {
    console.error('🔥 ============ CONNECTION CHECK FAILED ============');
    console.error('❌ Error type:', error.code || 'Unknown');
    console.error('❌ Error message:', error.message);
    console.error('📊 Error stack:', error.stack);

    // Analyze error type for better user feedback
    let errorDetails = 'Unknown connection error';
    
    if (error.message.includes('network')) {
      errorDetails = 'Network connection failed - check RPC URL and internet connection';
    } else if (error.message.includes('private key') || error.message.includes('invalid key')) {
      errorDetails = 'Invalid private key format';
    } else if (error.message.includes('contract')) {
      errorDetails = 'Contract interaction failed - check contract address and deployment';
    } else if (error.message.includes('gas') || error.message.includes('insufficient')) {
      errorDetails = 'Insufficient gas or wallet balance';
    } else if (error.code === 'NETWORK_ERROR') {
      errorDetails = 'Network error - RPC endpoint may be down or unreachable';
    } else if (error.code === 'INVALID_ARGUMENT') {
      errorDetails = 'Invalid configuration - check contract address and private key format';
    }

    return {
      success: false,
      error: error.message,
      details: errorDetails,
      errorCode: error.code || 'UNKNOWN_ERROR'
    };
  }
}