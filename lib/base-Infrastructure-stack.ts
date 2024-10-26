import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as rds from "aws-cdk-lib/aws-rds"
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export class BaselineInfrastructure extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC
    const infraVpc = new ec2.Vpc(this, "InfraVpc", {
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

    // Security Groups
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: infraVpc,
      description: 'Security group for OpenWebUI RDS instance',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-db-sg'
    });

    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: infraVpc,
      description: 'Security group for OpenWebUI ECS tasks',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-ecs-sg'
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: infraVpc,
      description: 'Security group for ALB',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-alb-sg'
    });

    // Security Group Rules
    dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from ECS tasks'
    );

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic'
    );

    ecsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(8080),
      'Allow traffic from ALB'
    );

    // RDS Instance
    const dbInstance = new rds.DatabaseInstance(this, "OpenWebUIDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_13
      }),
      vpc: infraVpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      databaseName: 'openwebui_db',
      port: 5432,
      allocatedStorage: 20,
      securityGroups: [dbSecurityGroup],
      instanceIdentifier: 'openwebui-db',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ECR Repository
    const ecrRepository = new ecr.Repository(this, 'ecrRepository', {
      repositoryName: 'llm-platform-ecr-repo',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE
    });

    // ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'OpenWebUIALB', {
      vpc: infraVpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'OpenWebUITargetGroup', {
      vpc: infraVpc,
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
    const listener = alb.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [targetGroup]
    });

    // Create the roles
    const taskRole = new iam.Role(this, 'OpenWebUITaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role that the task definition will use to run the container',
    });

    const executionRole = new iam.Role(this, 'OpenWebUIExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role that ECS will use to start the task',
    });

    // Task Definition
    const openWebUITaskDef = new ecs.FargateTaskDefinition(this, 'OpenWebUITask', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole: taskRole,
      executionRole: executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Add permissions
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
          'kms:Decrypt'
        ],
        resources: [dbInstance.secret!.secretArn]
      })
    );

    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel'
        ],
        resources: ['*']
      })
    );

    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents'
        ],
        resources: ['*']
      })
    );

    // Container Definition
    const openWebUIContainer = openWebUITaskDef.addContainer('OpenWebUI', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'openwebui'),
      environment: {
        'WEBUI_SECRET_KEY': '123456',
        'DEBUG': 'true',
        'DATABASE_TYPE': 'postgres',
        'DATABASE_URL': `postgresql://postgres:=9nKAy=xNJpGycGv3WM7WHnAOONcNU@openwebui-db.ce0twoub7pwu.us-west-2.rds.amazonaws.com:5432/openwebui_db`,
      },
      secrets: {
        'WEBUI_DB_USER': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'username'),
        'WEBUI_DB_PASSWORD': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'password'),
        'WEBUI_DB_HOST': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'DATABASE_URL'),
        'WEBUI_DB_PORT': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'port'),
        'WEBUI_DB_NAME': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'dbname'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'openwebui',
        logRetention: logs.RetentionDays.ONE_WEEK,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        datetimeFormat: '%Y-%m-%d %H:%M:%S',
        multilinePattern: '^\\S+'
      }),
      healthCheck: {
        command: [
          "CMD-SHELL", 
          "env && curl -f http://localhost:8080/health || exit 1"
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    openWebUIContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'OpenWebUICluster', {
      vpc: infraVpc,
      containerInsights: true,
    });

    // ECS Service
    const openWebUIService = new ecs.FargateService(this, 'OpenWebUIService', {
      cluster: cluster,
      taskDefinition: openWebUITaskDef,
      desiredCount: 1,
      securityGroups: [ecsSecurityGroup],
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      enableExecuteCommand: true,
    });

    openWebUIService.attachToApplicationTargetGroup(targetGroup);

    // Outputs
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: 'ecrRepositoryUri'
    });

    new cdk.CfnOutput(this, 'DBEndpoint', {
      value: dbInstance.instanceEndpoint.hostname,
      description: 'RDS instance endpoint',
      exportName: 'dbEndpoint'
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS Name',
      exportName: 'albDnsName'
    });
  }
}