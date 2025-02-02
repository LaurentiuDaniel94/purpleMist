import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

export class BaselineVPCInfrastructure extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly bedrockGatewaySecurityGroup: ec2.SecurityGroup;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with specific CIDR block
    this.vpc = new ec2.Vpc(this, "baseInfraVPC", {
      maxAzs: 3,
      natGateways: 1,
      vpcName: "llm-platform-vpc",
      restrictDefaultSecurityGroup: true,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/24'),
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 28,
        },
        {
          name: 'OpenWebUI-Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 28,
        },
        {
          name: 'BedrockGateway-Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 28,
        }
      ]
    });

    // Security Groups
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for OpenWebUI RDS instance',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-db-sg'
    });

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for OpenWebUI ECS tasks',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-ecs-sg'
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for ALB',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-alb-sg'
    });

    this.bedrockGatewaySecurityGroup = new ec2.SecurityGroup(this, 'BedrockGatewaySecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Bedrock Gateway',
      allowAllOutbound: true,
      securityGroupName: 'bedrock-gateway-sg'
    });

    // Security Group Rules
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic'
    );

    this.ecsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
      ec2.Port.tcp(8080),
      'Allow traffic from ALB'
    );

    this.bedrockGatewaySecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(80),
      'Allow traffic from OpenWebUI'
    );

    this.dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from ECS tasks'
    );

    // ALB
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'OpenWebUIALB', {
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });

    // Target Group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'OpenWebUITargetGroup', {
      vpc: this.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3
      }
    });

    // ALB Listener
    const listener = this.alb.addListener('OpenWebUIListener', {
      port: 80,
      defaultTargetGroups: [this.targetGroup]
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: 'vpcId'
    });

    new cdk.CfnOutput(this, 'PublicSubnets', {
      value: JSON.stringify(this.vpc.publicSubnets.map(s => s.subnetId)),
      description: 'Public Subnet IDs',
      exportName: 'publicSubnetIds'
    });

    new cdk.CfnOutput(this, 'PrivateSubnets', {
      value: JSON.stringify(this.vpc.privateSubnets.map(s => s.subnetId)),
      description: 'Private Subnet IDs',
      exportName: 'privateSubnetIds'
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS Name',
      exportName: 'albDnsName'
    });

    // Tags
    cdk.Tags.of(this).add('Project', 'LLMPlatform');
    cdk.Tags.of(this).add('Environment', 'Dev');
  }
}