// vpc-stack.ts
import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"

export class BaseVPCInfrastructure extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Base infrastructure
    this.vpc = new ec2.Vpc(this, "InfraVpc", {
      maxAzs: 3,
      natGateways: 1,
      vpcName: "llm-platform-vpc",
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        }
      ]
    });

    // VPC Endpoints
    this.vpc.addInterfaceEndpoint('EcrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addInterfaceEndpoint('SecretsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    this.vpc.addInterfaceEndpoint('EcsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECS,
    });

    this.vpc.addInterfaceEndpoint('EcsAgentEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
    });

    this.vpc.addInterfaceEndpoint('EcsTelemetryEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
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

    this.dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from ECS tasks'
    );
  }
}